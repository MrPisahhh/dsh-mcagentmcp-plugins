/**
 * dsh-agentmcp host 半边端到端冒烟测试（不需要 DSH，不需要 Minecraft）。
 *
 * 用一个 mock cordis ctx 调 apply()，捕获它注册的工具和 HTTP 路由，
 * 再起 test/fake-agentmcp.mjs 当服务端，把路由 handler 当成真实 HTTP 服务打一遍：
 *
 *   /state（未连接） → /connect → N 个工具注册（N 从 Java 源码读）→ 调工具拿到再包一层的 JSON
 *   → /call 透传 → /disconnect → 工具全部注销 → /reconnect → 工具回来
 *   → 坏 URL 保存后自动回滚 → 参数校验
 *
 * 用法：node test/smoke.mjs
 * 退出码 0 = 全过。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeAgentMcpServer } from './fake-agentmcp.mjs';
import { loadToolCatalog } from '../lib/tool-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FAKE_PORT = 25671; // 避开真实 25566，免得撞上用户正在跑的 Minecraft
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
/** 工具数量从 Java 源码动态读取，模组加工具时测试自动跟上。 */
const TOOL_COUNT = loadToolCatalog().length;
const TOOL_NAMES = loadToolCatalog().map((tool) => tool.name);
/** 状态文件放测试目录内，绝不写 ~/.dsh（沙箱禁止，也不该污染用户配置）。 */
const STATE_FILE = path.join(HERE, '.smoke-state.json');
try {
  fs.unlinkSync(STATE_FILE);
} catch {
  /* 不存在即可 */
}

let failures = 0;
let checks = 0;

/** 记一条断言。 */
function check(ok, label, detail) {
  checks++;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 等一小会儿。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等端口可用。 */
async function waitForPort(url, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  return false;
}

/* ─────────────────────── mock cordis ctx ─────────────────────── */

/** 已注册的工具：name → definition。 */
const registeredTools = new Map();
/** 已注册的路由。 */
let registeredRoute = null;
/** apply 里登记的 effect 清理函数。 */
const effectDisposers = [];

const mockCtx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    register(definition) {
      if (registeredTools.has(definition.name)) {
        throw new Error(`duplicate tool ${definition.name}`);
      }
      registeredTools.set(definition.name, definition);
      return () => registeredTools.delete(definition.name);
    },
  },
  // ctx.inject 的服务我们都「已有」：直接以自身调用回调，并把返回的 effect 收集起来。
  inject(_deps, callback) {
    return callback(mockCtx);
  },
  systemPrompt: {
    getSectionOrder: () => 3100,
    section() {
      return () => {};
    },
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') effectDisposers.push(disposer);
    return disposer;
  },
  webServer: {
    register(route) {
      registeredRoute = route;
      return () => {
        registeredRoute = null;
      };
    },
  },
};

/* ─────────────────────── 起一个真 HTTP server 打路由 ─────────────────────── */

/**
 * 把 host 插件的 handler 挂到一个临时 HTTP server 上，模拟 DSH 的 webServer。
 * @returns `{ close, callApi }`。
 */
async function serveHandler(handler) {
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  /** 打一次 API。DSH 的 webServer 是 prefix 路由，会把完整 pathname 交给 handler。 */
  const callApi = async (sub, body) => {
    const init = body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(`http://127.0.0.1:${port}/dsh-agentmcp/api${sub}`, init);
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  };

  return {
    callApi,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ─────────────────────── 主流程 ─────────────────────── */

console.log('[0] 起假 AgentMCP 服务端');
// 直接在当前进程里起，不用 spawn —— DSH 的沙箱禁止子进程（spawn EPERM）。
const fake = createFakeAgentMcpServer({ port: FAKE_PORT });
await fake.listen();
check(fake.toolCount === TOOL_COUNT, `假服务端提供 ${TOOL_COUNT} 个工具`, fake.toolCount);
const portReady = await waitForPort(FAKE_URL);
check(portReady, `假服务端在 ${FAKE_PORT} 就绪`);

console.log('\n[1] 加载插件并接线');
let bridge;
try {
  const mod = await import(`file://${path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/')}`);
  check(typeof mod.apply === 'function', '导出 apply');
  check(mod.name === 'agentmcp', "name === 'agentmcp'", mod.name);
  check(Array.isArray(mod.inject) && mod.inject.includes('tools'), "inject 含 'tools'", mod.inject);

  // 指向假服务端，且不自动连接（我们要自己控制时序）。
  bridge = mod.apply(mockCtx, {
    url: `${FAKE_URL}/mcp`,
    autoStart: false,
    toolCallTimeoutMs: 15000,
    statePath: STATE_FILE,
  });
  check(true, 'apply() 无异常');
} catch (error) {
  check(false, 'apply() 无异常', error.stack ?? error.message);
  await fake.close();
  process.exit(1);
}

check(registeredTools.has('agentmcp_bridge'), '注册了 agentmcp_bridge 控制工具');
check(registeredRoute !== null, '注册了 /dsh-agentmcp/api 路由');
if (!registeredRoute) {
  await fake.close();
  process.exit(1);
}
check(registeredRoute.kind === 'prefix', "路由 kind 是 'prefix'", registeredRoute.kind);
check(registeredRoute.path === '/dsh-agentmcp/api', '路由路径正确', registeredRoute.path);

const api = await serveHandler(registeredRoute.handler);

console.log('\n[2] /state（未连接）');
let r = await api.callApi('/state');
check(r.status === 200 && r.body?.ok === true, 'GET /state 返回 ok', r.status);
check(r.body?.connected === false, '初始未连接', r.body?.connected);
check(r.body?.health?.ok === true && r.body?.health?.in_game === true, '/health 探活成功', r.body?.health);
check(r.body?.toolCount === 0, '初始工具数为 0', r.body?.toolCount);

console.log(`\n[3] /connect → ${TOOL_COUNT} 个工具`);
r = await api.callApi('/connect', {});
check(r.status === 200 && r.body?.ok === true, 'connect 成功', r.body?.message);
check(r.body?.toolCount === TOOL_COUNT, `注册了 ${TOOL_COUNT} 个工具`, r.body?.toolCount);
check(r.body?.connected === true, 'state.connected = true');
check(registeredTools.size === TOOL_COUNT + 1, `工具表里 ${TOOL_COUNT} 个 MCP 工具 + 1 个 bridge`, registeredTools.size);
check(registeredTools.has('mcp__agentmcp__get_status'), 'mcp__agentmcp__get_status 存在');
// 抽查几个「较新」的工具，确保动态解析没漏掉源码尾部的注册。
for (const name of ['dig_stairs', 'use_workstation', 'emote', 'write_sign']) {
  if (TOOL_NAMES.includes(name)) {
    check(registeredTools.has(`mcp__agentmcp__${name}`), `工具 ${name} 已注册`);
  }
}
// 全部工具都应注册上，不只是抽查。
const missing = TOOL_NAMES.filter((name) => !registeredTools.has(`mcp__agentmcp__${name}`));
check(missing.length === 0, '源码里所有工具都在工具表里', missing);

console.log('\n[4] 工具执行 → 再包一层的 JSON');
const statusTool = registeredTools.get('mcp__agentmcp__get_status');
check(typeof statusTool?.execute === 'function', 'get_status 有 execute');
try {
  const value = await statusTool.execute({ value: 'hi' });
  check(Array.isArray(value?.content), 'execute 返回 { content }', Object.keys(value ?? {}));
  const text = value.content?.[0]?.text;
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^"|"$/g, ''));
  } catch {
    parsed = undefined;
  }
  // Java 端 content[0].text 是 JSON 字符串；我们透传原始 content 块，
  // render() 负责把 text 拼出来，所以这里断言 text 里含 ok:true。
  check(String(text).includes('"ok":true') || String(text).includes('"ok": true'), 'text 里是 JSON 字符串', String(text).slice(0, 160));
  check(typeof statusTool.output.render === 'function', 'output 有 render');
  const rendered = statusTool.output.render({}, value);
  check(Array.isArray(rendered) && rendered[0]?.type === 'text', 'render 产出 text 块', rendered);
} catch (error) {
  check(false, '工具执行无异常', error.message);
}

console.log('\n[5] /call 透传');
r = await api.callApi('/call', { tool: 'get_situation', arguments: { value: 'x' } });
check(r.status === 200 && r.body?.ok === true, '/call 成功', r.body?.message);
check(String(r.body?.text).includes('get_situation'), '/call 返回工具结果文本', r.body?.text);
check(typeof r.body?.elapsedMs === 'number', '/call 带耗时', r.body?.elapsedMs);

console.log('\n[6] /disconnect → 工具全注销');
r = await api.callApi('/disconnect', {});
check(r.status === 200 && r.body?.ok === true, 'disconnect 成功');
check(r.body?.connected === false, 'state.connected = false');
check(registeredTools.size === 1, '只剩 agentmcp_bridge', registeredTools.size);
check(r.body?.toolCount === 0, 'toolCount 归零', r.body?.toolCount);

console.log('\n[7] /reconnect → 工具回来');
r = await api.callApi('/reconnect', {});
check(r.status === 200 && r.body?.ok === true, 'reconnect 成功', r.body?.message);
check(r.body?.toolCount === TOOL_COUNT, `重连后仍 ${TOOL_COUNT} 个工具`, r.body?.toolCount);
check(registeredTools.size === TOOL_COUNT + 1, '工具表未叠加', registeredTools.size);

console.log('\n[8] 配置校验');
r = await api.callApi('/save', { url: 'ftp://bad' });
check(r.status === 400, '非法 url 被拒', r.status);
r = await api.callApi('/save', { serverName: 'bad name!' });
check(r.status === 400, '非法 serverName 被拒', r.status);
r = await api.callApi('/save', { toolCallTimeoutMs: 10 });
check(r.status === 400, '过小超时被拒', r.status);

console.log('\n[9] 坏 URL 保存后自动回滚');
r = await api.callApi('/save', { url: 'http://127.0.0.1:9/mcp' });
check(r.status === 502, '连不上返回 502', { status: r.status, message: r.body?.message });
// 回滚后 state.url 应该回到假服务端地址，仍然能连回来。
r = await api.callApi('/state');
check(r.body?.url === `${FAKE_URL}/mcp`, '坏 URL 已回滚', r.body?.url);
check(r.body?.connected === true, '回滚后连接已恢复（不该因为一次失败保存掉线）', r.body?.connected);
check(r.body?.toolCount === TOOL_COUNT, '回滚后工具数恢复', r.body?.toolCount);

console.log('\n[10] /catalog 工具目录');
r = await api.callApi('/catalog');
check(r.status === 200 && r.body?.ok === true, 'GET /catalog 成功', r.status);
check(r.body?.count === TOOL_COUNT, `目录含 ${TOOL_COUNT} 个工具`, r.body?.count);
check(Array.isArray(r.body?.groups) && r.body.groups.length >= 4, '目录按分类分组', r.body?.groups?.map((g) => g.key));
const catalogTool = (r.body?.tools ?? []).find((tool) => tool.name === 'emote');
check(catalogTool?.schema?.properties?.gesture !== undefined, 'emote 带真实参数 schema', catalogTool?.schema);
check(String(catalogTool?.description).includes('gesture'), 'emote 带真实描述');
// /state 也要带上目录数与诊断
r = await api.callApi('/state');
check(r.body?.catalogCount === TOOL_COUNT, 'state 带 catalogCount', r.body?.catalogCount);
check(r.body?.diagnosis?.level === 'ok' && String(r.body?.diagnosis?.hint).includes('工具'), 'state 带连接诊断', r.body?.diagnosis);

console.log('\n[10b] /task-list 推送 HUD');
r = await api.callApi('/task-list', { tasks: [{ text: '观察周围' }, { text: '采集资源', status: 'done' }] });
check(r.status === 200 && r.body?.ok === true, 'task-list 推送成功', { status: r.status, message: r.body?.message });
r = await api.callApi('/task-list', { tasks: Array.from({ length: 13 }, (_, i) => ({ text: `t${i}` })) });
check(r.status === 400, '超过 12 条被拒', r.status);

console.log('\n[11] 桥接控制工具');
const bridgeTool = registeredTools.get('agentmcp_bridge');
check(typeof bridgeTool?.execute === 'function', 'agentmcp_bridge 可调用');
try {
  const status = await bridgeTool.execute({ action: 'status' });
  check(status?.connected === true || status?.connected === false, 'action=status 返回状态', Object.keys(status ?? {}));
} catch (error) {
  check(false, 'agentmcp_bridge 执行无异常', error.message);
}

console.log('\n[11] 清理');
await api.callApi('/disconnect', {});
check(registeredTools.size === 1, '断开后只剩 bridge', registeredTools.size);
for (const dispose of effectDisposers.reverse()) {
  try {
    const result = dispose();
    if (result && typeof result.then === 'function') await result;
  } catch {
    /* 清理失败不影响断言 */
  }
}
check(registeredTools.size === 0, '插件卸载后工具全清', registeredTools.size);

await api.close();
await fake.close();
try {
  fs.unlinkSync(STATE_FILE);
} catch {
  /* 没生成就算了 */
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
