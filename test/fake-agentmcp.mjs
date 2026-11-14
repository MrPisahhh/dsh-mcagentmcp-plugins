/**
 * 假的 AgentMCP 服务端：模拟 Java 端 McpServer 的协议，用来在不开 Minecraft 的情况下
 * 端到端测 dsh-agentmcp 的 host 半边。
 *
 * 对照 src/main/java/com/agentmcp/mcp/McpServer.java：
 *   - /mcp 只收 POST JSON-RPC 2.0；GET 回 405；通知（无 id）回 202 且带 Mcp-Session-Id
 *   - /health 只收 GET，回 ok/name/version/in_game/player/port/uptime_seconds/tools
 *   - initialize 原样回显 protocolVersion，带 instructions
 *   - tools/call 的 content[0].text 是再包一层的 JSON 字符串
 *   - authToken 非空时要求 Authorization: Bearer
 *
 * 既可作为模块导入（createFakeAgentMcpServer），也可直接跑：
 *   node test/fake-agentmcp.mjs [--port 25566] [--token xxx]
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadToolCatalog, parseSchema } from '../lib/tool-catalog.mjs';

/** 与 Java 端 INSTRUCTIONS 同形的简短版本。 */
const INSTRUCTIONS = 'Minecraft control server. Call get_status for position/health. '
  + 'Only one long-running action can run at a time; wait for the result before another action.';

/**
 * 工具清单**从 Java 源码动态解析**，不写死数量。
 * 模组加工具后假服务器自动跟上，测试断言也跟着变。
 */
const CATALOG = loadToolCatalog();
const TOOLS = CATALOG.map((tool) => ({
  name: tool.name,
  description: `[${tool.category}] ${tool.description || `Fake ${tool.name} for smoke testing.`}`,
  inputSchema: parseSchema(tool.schema),
}));

/** JSON-RPC 结果 / 错误。 */
const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * 创建一个假服务端（不自动 listen，由调用方决定）。
 * @param options - `{ port, token, sessionId }`。
 * @returns `{ server, close, port }`。
 */
export function createFakeAgentMcpServer(options = {}) {
  const port = options.port ?? 25566;
  const token = options.token ?? '';
  const sessionId = options.sessionId ?? 'fake-session-0001';
  const started = Date.now();

  /** 写响应。 */
  const send = (res, status, body, extraHeaders = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'mcp-session-id': sessionId,
      ...extraHeaders,
    });
    res.end(text);
  };

  /** 处理单条消息。返回 null 表示通知（不回包）。 */
  const processMessage = (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return error(null, -32600, 'Invalid Request');
    if (message.id === undefined || message.id === null) return null;

    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion || '2025-06-18';
        return result(message.id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agentmcp', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return result(message.id, {});
      case 'tools/list':
        return result(message.id, { tools: TOOLS });
      case 'tools/call': {
        const name = message.params?.name;
        const tool = TOOLS.find((row) => row.name === name);
        if (!tool) return error(message.id, -32602, `unknown tool: ${String(name)}`);
        const payload = { ok: true, tool: name, echoed: message.params?.arguments ?? {} };
        return result(message.id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        });
      }
      default:
        return error(message.id, -32601, `Method not found: ${String(message.method)}`);
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // 鉴权：与 Java 端 authorized() 一致。
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, 'unauthorized');
      return;
    }

    if (url.pathname === '/health') {
      if (req.method !== 'GET') {
        send(res, 405, { ok: false, error: 'use GET' });
        return;
      }
      send(res, 200, {
        ok: true,
        name: 'agentmcp',
        version: '1.0.0',
        minecraft: '1.21.11',
        port,
        in_game: true,
        player: 'FakePlayer',
        uptime_seconds: Math.floor((Date.now() - started) / 1000),
        tools: TOOLS.length,
      });
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        res.setHeader('Allow', 'POST');
        send(res, 405, error(null, -32601, 'SSE streams are not supported; POST JSON-RPC to /mcp'));
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        send(res, 405, 'method not allowed');
        return;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let root;
        try {
          root = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (exception) {
          send(res, 400, error(null, -32700, `Parse error: ${exception.message}`));
          return;
        }
        const responses = (Array.isArray(root) ? root : [root])
          .map(processMessage)
          .filter((row) => row !== null);
        if (responses.length === 0) {
          res.writeHead(202, { 'mcp-session-id': sessionId });
          res.end();
          return;
        }
        send(res, 200, Array.isArray(root) ? responses : responses[0]);
      });
      return;
    }

    send(res, 404, { ok: false, error: 'not found' });
  });

  return {
    server,
    port,
    toolCount: TOOLS.length,
    /** 监听。 */
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    /** 关闭。 */
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 是否被当作脚本直接运行。 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
  };
  const fake = createFakeAgentMcpServer({
    port: Number(opt('--port', 25566)),
    token: opt('--token', ''),
  });
  fake.listen().then(() => {
    console.log(`fake-agentmcp listening on http://127.0.0.1:${fake.port} (tools=${fake.toolCount})`);
  });
  process.on('SIGTERM', () => fake.close().then(() => process.exit(0)));
  process.on('SIGINT', () => fake.close().then(() => process.exit(0)));
}
