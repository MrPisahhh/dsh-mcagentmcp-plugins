/**
 * dsh-agentmcp —— host 半边。
 *
 * 干什么：把本仓库 AgentMCP 模组（Fabric / Minecraft）暴露的 MCP 服务接进 DSH，
 * 让模型能用 `mcp__agentmcp__<tool>` 直接操作游戏里的玩家。
 *
 * 为什么**不用** `@deepseek-ai/dsh-mcp-client`：
 *   实测（2026-11-01）profile 的 `node_modules/@deepseek-ai/*` 全是指向旧安装
 *   路径 `D:\APPS\DeepSeekHarness\...` 的断链 junction，DSH 实际跑在
 *   `D:\APPS\新建文件夹 (5)\DSH`，于是 `import('@deepseek-ai/dsh-mcp-client')`
 *   直接 MODULE_NOT_FOUND（dsh-mcp-console 的动态挂载就是这么挂的，见
 *   `/dsh-mcp-console/api/save` 的返回）。这个插件因此自带一个极简 MCP 客户端：
 *   只用 node 内置模块 + 全局 fetch，零运行时依赖，装到哪都不会再踩断链。
 *
 * 协议要点（见 AgentUseMCPSkill/SKILL.md 与 src/main/java/com/agentmcp/mcp/McpServer.java）：
 *   - Streamable HTTP，**只收 POST JSON-RPC 2.0**；不支持 SSE / GET。
 *   - `initialize` 必须带 protocolVersion（服务端会原样回显）。
 *   - 单次工具调用服务端硬上限 95 秒，超时会强制停动作。
 *   - 工具返回 `content[0].text` 是一段**再包一层的 JSON 字符串**。
 *
 * @module dsh-agentmcp
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadToolCatalog, parseSchema, groupByCategory, CATEGORY_LABELS } from './tool-catalog.mjs';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'agentmcp';

/** 本插件需要工具注册表。 */
export const inject = ['tools'];

/** 浏览器面板用的同源接口前缀。 */
const ROUTE_PREFIX = '/dsh-agentmcp/api';

/** 服务端协议版本（McpServer.DEFAULT_PROTOCOL_VERSION）。 */
const PROTOCOL_VERSION = '2025-06-18';

/** 服务端单次调用硬上限 95 秒；留 5 秒余量给网络与序列化。 */
const SERVER_HARD_LIMIT_MS = 95_000;

/** 公开工具名前缀：与 dsh-mcp-client 的命名约定保持一致。 */
const TOOL_PREFIX = 'mcp__';

/** 默认配置。 */
const DEFAULTS = Object.freeze({
  serverName: 'agentmcp',
  url: 'http://127.0.0.1:25566/mcp',
  authToken: '',
  toolCallTimeoutMs: 90_000,
  autoStart: true,
});

/* ───────────────────────────── 小工具 ───────────────────────────── */

/**
 * 解析 `~/.dsh`（或 DSH_HOME），用来放本插件的运行期状态。
 * @returns DSH home 绝对路径。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/**
 * 状态文件路径。可由 config.statePath / DSH_AGENTMCP_STATE 覆盖（测试与多实例用）。
 * @returns 绝对路径。
 */
function statePath() {
  const explicit = process.env.DSH_AGENTMCP_STATE?.trim() || statePathOverride;
  if (explicit) return path.resolve(explicit);
  return path.join(dshHome(), 'agentmcp', 'bridge.json');
}

/** apply() 里设置的路径覆盖。 */
let statePathOverride = '';
/** 内存态覆盖：写盘失败时仍保证本次会话的配置生效。 */
let memoryState = null;
/** 最近一次状态写盘失败原因；null 表示正常。 */
let lastStateError = null;

/**
 * 读持久化状态；坏文件一律当空表 —— 不能因为一个坏 JSON 打不开面板。
 * 有内存态时优先返回内存态（写盘失败后的兜底）。
 * @returns `{}` 或已保存的覆盖项。
 */
function readState() {
  if (memoryState) return { ...memoryState };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 原子写状态：先写临时文件再 rename，避免半截 JSON。
 *
 * 写盘失败（目录只读、沙箱限制等）**不抛**：内存态仍然生效，本次会话照常可用。
 * 失败原因记在 lastStateError，由 /state 暴露给面板，避免「保存了但重启就没了」被误认为成功。
 * @param state - 要写入的对象。
 * @returns 是否成功落盘。
 */
function writeState(state) {
  const file = statePath();
  // 先更新内存态：即使写盘失败，本次会话的配置也必须立刻生效。
  memoryState = { ...state };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    lastStateError = null;
    return true;
  } catch (error) {
    lastStateError = String(error?.message ?? error);
    return false;
  }
}

/**
 * 把配置与持久化覆盖项合并成最终配置。
 * @param config - 插件 config（cordis.patch.yml 里那一份）。
 * @returns 完整配置。
 */
function resolveConfig(config) {
  const saved = readState();
  const merged = { ...DEFAULTS, ...config, ...saved };
  merged.serverName = String(merged.serverName || DEFAULTS.serverName);
  merged.url = String(merged.url || DEFAULTS.url);
  merged.authToken = String(merged.authToken ?? '');
  merged.toolCallTimeoutMs = Math.min(
    SERVER_HARD_LIMIT_MS,
    Math.max(1_000, Number(merged.toolCallTimeoutMs) || DEFAULTS.toolCallTimeoutMs),
  );
  merged.autoStart = merged.autoStart !== false;
  return merged;
}

/**
 * 从 MCP 端点推出 `/health` 地址。
 * @param url - MCP 端点。
 * @returns health 地址。
 */
function healthUrlOf(url) {
  try {
    return new URL('/health', url).href;
  } catch {
    return 'http://127.0.0.1:25566/health';
  }
}

/* ─────────────────────────── 极简 MCP 客户端 ─────────────────────────── */

/**
 * 一个只够用的 MCP over Streamable-HTTP 客户端：POST JSON-RPC，收 JSON（容忍 SSE 帧）。
 */
class MiniMcpClient {
  /**
   * @param opts - `{ url, authToken, timeoutMs, clientName }`。
   */
  constructor(opts) {
    this.url = opts.url;
    this.authToken = opts.authToken ?? '';
    this.timeoutMs = opts.timeoutMs;
    this.clientName = opts.clientName ?? 'dsh-agentmcp';
    this.nextId = 1;
    this.sessionId = null;
    this.serverInfo = null;
    this.instructions = '';
  }

  /** 组装请求头。 */
  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }

  /**
   * 发一个 JSON-RPC 请求。
   * @param method - 方法名。
   * @param params - 参数对象。
   * @param timeoutMs - 覆盖超时。
   * @returns `result` 字段。
   * @throws 网络错误、HTTP 非 2xx、JSON-RPC error。
   */
  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError'
        ? `请求超时（${timeoutMs}ms）`
        : String(error?.cause?.code ?? error?.message ?? error);
      throw new Error(`${method} 请求失败：${reason}`);
    }

    // 服务端通知（202）没有响应体。
    if (response.status === 202 || response.status === 204) return {};

    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader) this.sessionId = sessionHeader;

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} HTTP ${response.status}：${text.slice(0, 300) || '(空响应)'}`);
    }

    const payload = parseJsonRpcBody(text);
    if (!payload) throw new Error(`${method} 返回的不是 JSON-RPC：${text.slice(0, 300)}`);
    if (payload.error) {
      throw new Error(`${method} 失败（${payload.error.code}）：${payload.error.message ?? ''}`);
    }
    return payload.result ?? {};
  }

  /**
   * 握手。拿到 serverInfo / instructions，并记下 session id。
   * @returns initialize 的 result。
   */
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: this.clientName, version: '0.1.0' },
    });
    this.serverInfo = result.serverInfo ?? null;
    this.instructions = typeof result.instructions === 'string' ? result.instructions : '';
    // 规范要求握手后发一条 notifications/initialized；服务端会忽略通知体。
    void this.notify('notifications/initialized').catch(() => {});
    return result;
  }

  /**
   * 发一条通知（无 id、不期待响应）。
   * @param method - 方法名。
   * @param params - 参数。
   */
  async notify(method, params = {}) {
    await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
    });
  }

  /**
   * 列出工具。
   * @returns 工具数组。
   */
  async listTools() {
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /**
   * 调一个工具。
   * @param toolName - 原始工具名。
   * @param args - 参数对象。
   * @param timeoutMs - 覆盖超时（服务端硬上限 95 秒）。
   * @returns `{ isError, text, value, raw }`。
   */
  async callTool(toolName, args, timeoutMs = this.timeoutMs) {
    const result = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs);
    const text = extractText(result?.content);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    return { isError: result?.isError === true, text, value, raw: result };
  }
}

/**
 * 解析响应体：优先当 JSON，其次按 SSE 的 `data:` 行取最后一条。
 * @param text - 原始响应文本。
 * @returns JSON-RPC 报文，或 undefined。
 */
function parseJsonRpcBody(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 落到 SSE 解析 */
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(dataLines[index]);
    } catch {
      /* 继续往前找 */
    }
  }
  return undefined;
}

/**
 * 把 MCP content 数组拍成纯文本。
 * @param content - `[{type:'text', text}]`。
 * @returns 拼接后的文本。
 */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block && block.type === 'image') return '[image block omitted]';
      if (block && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/* ────────────────────────────── 插件本体 ────────────────────────────── */

/** 工具目录缓存（从 Java 源码解析，只解析一次）。 */
let catalogCache = null;

/**
 * 取得工具目录。解析失败只警告并返回空表 —— 目录是面板的增强信息，
 * 绝不能因为 Java 源码临时不可读就让整个插件起不来。
 * @returns 工具数组。
 */
function catalog() {
  if (catalogCache) return catalogCache;
  try {
    catalogCache = loadToolCatalog();
  } catch (error) {
    ctxLogger?.warn?.(`[agentmcp] 工具目录解析失败：${error?.message ?? error}`);
    catalogCache = [];
  }
  return catalogCache;
}

/** apply 里设置的 logger，供模块级 catalog() 用。 */
let ctxLogger = null;

/**
 * 装上 AgentMCP 桥。
 * @param ctx - cordis 插件上下文（需要 tools 服务）。
 * @param config - `{ serverName, url, authToken, toolCallTimeoutMs, autoStart, statePath }`。
 */
export function apply(ctx, config) {
  ctxLogger = ctx.logger ?? null;
  catalogCache = null;
  // 允许通过 config.statePath 覆盖状态文件位置（多实例 / 测试）。
  // 这是模块级变量：同一进程里只应有一个 agentmcp 插件实例。
  statePathOverride = typeof config?.statePath === 'string' ? config.statePath.trim() : '';
  memoryState = null;
  lastStateError = null;
  let current = resolveConfig(config);
  /** 当前客户端；null 表示未连接。 */
  let client = null;
  /** 已注册工具的 disposer，卸载/断开时统一回收。 */
  const disposers = new Map();
  /** 最近一次连接尝试的结果，给面板看。 */
  let lastError = null;
  let connecting = null;
  /**
   * 连接代次：每次 disconnect / reconnect 递增。
   * 用来丢弃「断开之后才慢吞吞完成」的旧连接，避免把工具注册回一个已经被用户断开的桥。
   */
  let generation = 0;

  /** 公开工具名。 */
  const publicName = (rawName) => `${TOOL_PREFIX}${current.serverName}__${rawName}`;

  /**
   * 探活：GET /health。
   * @returns `{ ok, ... }`；失败时 `{ ok:false, error }`。
   */
  async function probeHealth() {
    try {
      const response = await fetch(healthUrlOf(current.url), {
        signal: AbortSignal.timeout(5_000),
        headers: current.authToken ? { authorization: `Bearer ${current.authToken}` } : {},
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      const parsed = JSON.parse(text);
      return { ok: true, ...parsed };
    } catch (error) {
      return { ok: false, error: String(error?.cause?.code ?? error?.message ?? error) };
    }
  }

  /** 把所有已注册工具摘掉。 */
  function unregisterTools() {
    for (const [toolName, dispose] of disposers) {
      try {
        dispose();
      } catch (error) {
        ctx.logger?.warn?.(`[agentmcp] 注销 ${toolName} 失败：${error?.message ?? error}`);
      }
    }
    disposers.clear();
  }

  /**
   * 把 MCP 工具定义适配成 DSH 的 ToolDefinition。
   * 结构与 `@deepseek-ai/dsh-mcp-client` 的 createMcpToolDefinition 对齐：
   * parameters 直接吃 MCP 的原始 JSON Schema，output 声明 `{content, structuredContent?}`。
   * @param tool - MCP 工具描述。
   * @param activeClient - 绑定的客户端。
   * @returns ToolDefinition。
   */
  function adaptTool(tool, activeClient) {
    const rawName = String(tool.name);
    const timeoutMs = current.toolCallTimeoutMs;
    return {
      name: publicName(rawName),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            structuredContent: {},
          },
          required: ['content'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: extractText(value?.content) }],
      },
      async execute(args) {
        const result = await activeClient.callTool(rawName, args ?? {}, timeoutMs);
        // MCP 的 isError 必须在图片/内容投影之前抛出，让调用记录成失败。
        if (result.isError) throw new Error(result.text || `${rawName} 执行失败`);
        return { content: result.raw?.content ?? [{ type: 'text', text: result.text }] };
      },
    };
  }

  /**
   * 连接并注册工具。可重入：并发调用共用同一个 promise。
   * @returns `{ ok, message, toolCount? }`。
   */
  async function connect() {
    if (client) return { ok: true, message: `已连接 ${current.serverName}`, toolCount: disposers.size };
    if (connecting) return connecting;

    const myGeneration = generation;
    /** 用户在我们握手期间点了断开吗？ */
    const stale = () => myGeneration !== generation;

    connecting = (async () => {
      const health = await probeHealth();
      if (stale()) return { ok: false, message: '连接已取消（期间收到断开请求）' };
      if (!health.ok) {
        lastError = `连不上 ${healthUrlOf(current.url)}：${health.error}。先确认 Minecraft 已进世界、模组已启用（config/agentmcp.json 的 enabled/port）。`;
        return { ok: false, message: lastError };
      }

      const next = new MiniMcpClient({
        url: current.url,
        authToken: current.authToken,
        timeoutMs: current.toolCallTimeoutMs,
      });

      try {
        await next.initialize();
      } catch (error) {
        lastError = `握手失败：${error?.message ?? error}`;
        return { ok: false, message: lastError };
      }
      if (stale()) return { ok: false, message: '连接已取消（握手期间收到断开请求）' };

      let tools;
      try {
        tools = await next.listTools();
      } catch (error) {
        lastError = `tools/list 失败：${error?.message ?? error}`;
        return { ok: false, message: lastError };
      }
      if (stale()) return { ok: false, message: '连接已取消（列工具期间收到断开请求）' };

      // 先全部构造再注册：任何一个 schema 不被接受都不该留下半个工具集。
      const registered = [];
      try {
        for (const tool of tools) {
          const definition = adaptTool(tool, next);
          const dispose = ctx.tools.register(definition);
          registered.push([definition.name, dispose]);
        }
      } catch (error) {
        for (const [, dispose] of registered) {
          try {
            dispose();
          } catch {
            /* 回滚失败不重要，下面还会整表清理 */
          }
        }
        lastError = `注册工具失败：${error?.message ?? error}`;
        return { ok: false, message: lastError };
      }

      // 最后一次检查：若期间被断开，把刚注册的工具立刻摘掉，别留下幽灵工具。
      if (stale()) {
        for (const [, dispose] of registered) {
          try {
            dispose();
          } catch {
            /* 已随 fiber 回收 */
          }
        }
        return { ok: false, message: '连接已取消（注册期间收到断开请求）' };
      }

      for (const [toolName, dispose] of registered) disposers.set(toolName, dispose);
      client = next;
      lastError = null;

      ctx.logger?.info?.(`[agentmcp] 已连接 ${current.url}，注册 ${registered.length} 个工具`);
      return {
        ok: true,
        message: `已连接 ${current.serverName}（${registered.length} 个工具，玩家 ${health.player ?? '?'}）`,
        toolCount: registered.length,
        health,
      };
    })().finally(() => {
      connecting = null;
    });

    return connecting;
  }

  /**
   * 断开并摘掉工具。
   * @returns `{ ok, message }`。
   */
  async function disconnect() {
    // 递增代次，让任何还在进行中的 connect() 自废弃。
    generation += 1;
    unregisterTools();
    client = null;
    lastError = null;
    return { ok: true, message: `已断开 ${current.serverName}` };
  }

  /** 断开再连。 */
  async function reconnect() {
    await disconnect();
    return connect();
  }

  /**
   * 把 health 结果翻译成人能照做的一句话。
   * 三种可区分的状态：端点不可达 / 在主菜单（未进世界）/ 已进世界。
   * @param health - probeHealth 的结果。
   * @param connected - 桥是否已连上。
   * @returns `{ level, hint }`。
   */
  function diagnose(health, connected) {
    if (!health?.ok) {
      return {
        level: 'error',
        hint: `连不上 ${healthUrlOf(current.url)}（${health?.error ?? '未知原因'}）。`
          + '先启动 Minecraft 并确认模组已启用：检查 config/agentmcp.json 的 enabled / port / bind。',
      };
    }
    if (health.in_game === false) {
      return {
        level: 'warn',
        hint: '模组在运行，但玩家还没进入世界（主菜单/加载中）。'
          + '进入一个存档后，除 get_status / close_screen 外的工具都会报 No world is loaded。',
      };
    }
    if (!connected) {
      return {
        level: 'warn',
        hint: `游戏内就绪（玩家 ${health.player ?? '?'}，服务端 ${health.tools ?? '?'} 个工具），但桥还没连。点「连接」注册工具。`,
      };
    }
    const expected = health.tools;
    if (Number.isFinite(expected) && expected !== disposers.size) {
      return {
        level: 'warn',
        hint: `服务端报告 ${expected} 个工具，桥只注册了 ${disposers.size} 个 —— 点「重连」刷新工具集。`,
      };
    }
    return {
      level: 'ok',
      hint: `已连接，玩家 ${health.player ?? '?'}，${disposers.size} 个工具可用。`,
    };
  }

  /**
   * 面板/接口用的状态快照。
   * @returns 状态对象。
   */
  async function state() {
    const health = await probeHealth();
    return {
      serverName: current.serverName,
      url: current.url,
      hasToken: Boolean(current.authToken),
      autoStart: current.autoStart,
      toolCallTimeoutMs: current.toolCallTimeoutMs,
      connected: Boolean(client),
      toolCount: disposers.size,
      tools: [...disposers.keys()].map((toolName) => toolName.slice(`${TOOL_PREFIX}${current.serverName}__`.length)),
      health,
      diagnosis: diagnose(health, Boolean(client)),
      lastError,
      statePath: statePath(),
      stateError: lastStateError,
      catalogCount: catalog().length,
    };
  }

  /* ─────────── 模型可调的桥接控制工具（只有一个，省 token） ─────────── */

  const bridgeTool = {
    name: 'agentmcp_bridge',
    description:
      'Inspect or control the Minecraft AgentMCP bridge (the connection to the local Minecraft mod). '
      + 'action=status reports connection state and the in-game health probe; action=connect connects and registers the '
      + 'minecraft tools; action=disconnect unregisters them; action=reconnect does both. '
      + 'Use status first when mcp__agentmcp__* tools are missing or failing.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'connect', 'disconnect', 'reconnect'],
          description: 'What to do; defaults to status',
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'status');
      if (action === 'connect') return { ...(await connect()), state: await state() };
      if (action === 'disconnect') return { ...(await disconnect()), state: await state() };
      if (action === 'reconnect') return { ...(await reconnect()), state: await state() };
      return await state();
    },
  };

  /* ─────────── HTTP 接口（浏览器面板用） ─────────── */

  /**
   * 读请求体并解析 JSON。
   * @param req - node 请求。
   * @param limit - 上限字节。
   * @returns 解析结果；空体返回 `{}`。
   */
  async function readJson(req, limit = 256 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error(`请求体超过 ${limit} 字节`);
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  }

  /**
   * 回 JSON。
   * @param res - node 响应。
   * @param status - 状态码。
   * @param body - 序列化的值。
   */
  function sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  /**
   * `/dsh-agentmcp/api/*` 的总入口。
   * @param req - node 请求。
   * @param res - node 响应。
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (sub === '/state' && method === 'GET') return sendJson(res, 200, { ok: true, ...(await state()) });

      // 工具目录：从 Java 源码解析，按分类分组，带描述与参数 schema。
      // 面板用它展示分组、搜索、以及「试一下」时该填什么参数。
      if (sub === '/catalog' && method === 'GET') {
        const tools = catalog().map((tool) => ({
          name: tool.name,
          description: tool.description,
          category: tool.category,
          schema: parseSchema(tool.schema),
        }));
        const groups = [...groupByCategory(tools).entries()].map(([key, rows]) => ({
          key,
          label: CATEGORY_LABELS[key] ?? key,
          tools: rows.map((row) => row.name),
        }));
        return sendJson(res, 200, { ok: true, count: tools.length, tools, groups });
      }

      // 把计划推到游戏 HUD（模组 set_task_list）。面板里的任务编辑器用它。
      if (sub === '/task-list' && method === 'POST') {
        const body = await readJson(req);
        if (!client) return sendJson(res, 409, { ok: false, message: '未连接，无法写入 HUD' });
        const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
        if (tasks.length > 12) return sendJson(res, 400, { ok: false, message: '任务最多 12 条' });
        const normalized = tasks
          .filter((row) => row && typeof row === 'object' && String(row.text ?? '').trim())
          .map((row) => ({
            text: String(row.text).trim().slice(0, 80),
            status: ['pending', 'active', 'done'].includes(row.status) ? row.status : 'pending',
          }));
        try {
          const result = await client.callTool('set_task_list', { tasks: normalized });
          return sendJson(res, 200, { ok: !result.isError, message: result.isError ? result.text : `已推送 ${normalized.length} 条任务到 HUD`, text: result.text });
        } catch (error) {
          return sendJson(res, 502, { ok: false, message: String(error?.message ?? error) });
        }
      }

      if (sub === '/save' && method === 'POST') {
        const body = await readJson(req);
        const previous = readState();

        // 先校验形状，别把非法值写进配置。
        if (typeof body.url === 'string' && body.url.trim() && !/^https?:\/\//i.test(body.url.trim())) {
          return sendJson(res, 400, { ok: false, message: 'url 必须以 http:// 或 https:// 开头', ...(await state()) });
        }
        if (typeof body.serverName === 'string' && body.serverName.trim() && !/^[A-Za-z0-9_-]{1,32}$/.test(body.serverName.trim())) {
          return sendJson(res, 400, { ok: false, message: 'serverName 必须是 1-32 位字母、数字、下划线或连字符', ...(await state()) });
        }

        const saved = { ...previous };
        if (typeof body.url === 'string' && body.url.trim()) saved.url = body.url.trim();
        if (typeof body.serverName === 'string' && body.serverName.trim()) saved.serverName = body.serverName.trim();
        // 令牌留空表示「保持现有值」，面板不会把它回填出来，避免误清空。
        if (typeof body.authToken === 'string' && body.authToken.trim()) saved.authToken = body.authToken.trim();
        if (typeof body.autoStart === 'boolean') saved.autoStart = body.autoStart;
        if (body.toolCallTimeoutMs !== undefined) {
          const numeric = Number(body.toolCallTimeoutMs);
          if (!Number.isFinite(numeric) || numeric < 1000) {
            return sendJson(res, 400, { ok: false, message: 'toolCallTimeoutMs 必须是 ≥ 1000 的数字', ...(await state()) });
          }
          saved.toolCallTimeoutMs = Math.min(SERVER_HARD_LIMIT_MS, numeric);
        }

        const wasConnected = Boolean(client);
        writeState(saved);
        // 配置变了就重建连接，让新 url / token 立刻生效。
        await disconnect();
        current = resolveConfig(config);
        const result = await connect();

        if (!result.ok) {
          // 连不上就回滚到改动前，避免坏 URL 永久写进配置、下次启动又失败一遍。
          // 但保留「用户主动关掉 autoStart」这种与连通性无关的改动意图：
          // 只要 URL/名字/令牌没变，就认为这次是纯开关变更，不回滚。
          const connectivityChanged = saved.url !== previous.url
            || saved.serverName !== previous.serverName
            || saved.authToken !== previous.authToken;
          if (connectivityChanged) {
            writeState(previous);
            current = resolveConfig(config);
            // 回滚配置后要把连接恢复到改动前的状态，否则一次失败的保存会把
            // 本来连得好好的桥留成断开 —— 用户只是想改个端口，不该因此掉线。
            if (wasConnected) await connect();
          }
        }
        return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, message: result.message, ...(await state()) });
      }

      if (sub === '/connect' && method === 'POST') {
        const result = await connect();
        return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, message: result.message, ...(await state()) });
      }

      if (sub === '/disconnect' && method === 'POST') {
        const result = await disconnect();
        return sendJson(res, 200, { ok: true, message: result.message, ...(await state()) });
      }

      if (sub === '/reconnect' && method === 'POST') {
        const result = await reconnect();
        return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, message: result.message, ...(await state()) });
      }

      // 直接透传一次工具调用：面板的「试一下」用它，也方便排障。
      if (sub === '/call' && method === 'POST') {
        const body = await readJson(req);
        const toolName = String(body.tool ?? '').trim();
        if (!toolName) return sendJson(res, 400, { ok: false, message: '缺少 tool' });
        if (!client) return sendJson(res, 409, { ok: false, message: '未连接' });
        const started = Date.now();
        try {
          const result = await client.callTool(toolName, body.arguments ?? {});
          return sendJson(res, 200, {
            ok: !result.isError,
            message: result.isError ? '服务端返回 isError' : 'ok',
            elapsedMs: Date.now() - started,
            text: result.text,
            value: result.value,
          });
        } catch (error) {
          return sendJson(res, 502, {
            ok: false,
            message: String(error?.message ?? error),
            elapsedMs: Date.now() - started,
          });
        }
      }

      return sendJson(res, 404, { ok: false, message: `未知接口 ${method} ${sub}` });
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: String(error?.message ?? error) });
    }
  }

  /* ─────────── 接线 ─────────── */

  // 控制工具先注册：即使 MCP 连不上，模型也有办法自查。
  const disposeBridgeTool = ctx.tools.register(bridgeTool);

  // 服务端 instructions 进系统提示词。**只注册一次**，文本动态读当前连接：
  // 早期版本把这段放在 connect() 里用 ctx.inject 注册，每重连一次就多一个 fiber
  // 和一段重复的提示词，而且 text 闭包捕获的是那一次的 client，断开后仍是旧值。
  // 现在未连接时返回空串，连接后自然带上 instructions，断开后自动消失。
  ctx.inject(['systemPrompt'], (inner) => {
    inner.effect(() => inner.systemPrompt.section({
      name: `mcp:${current.serverName}`,
      order: inner.systemPrompt.getSectionOrder?.('MCP_SERVERS') ?? 3100,
      interpolate: false,
      text: () => (client?.instructions ? `AgentMCP (Minecraft):\n${client.instructions}` : ''),
    }), 'agentmcp: instructions');
  });

  // 路由要等 webServer 就绪：profile 里的行序不保证 webServer 先于本插件加载。
  ctx.inject(['webServer'], (child) => {
    child.effect(
      () => child.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
      'agentmcp: routes',
    );
  });

  // 自动连接放微任务：apply 不该被 Minecraft 的慢启动拖住。
  ctx.effect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled || !current.autoStart) return;
      const result = await connect();
      if (!result.ok) ctx.logger?.warn?.(`[agentmcp] 自动连接失败：${result.message}`);
    });
    return () => {
      cancelled = true;
      unregisterTools();
      try {
        disposeBridgeTool();
      } catch {
        /* 已经随 fiber 一起回收 */
      }
      client = null;
    };
  }, 'agentmcp: lifecycle');
}
