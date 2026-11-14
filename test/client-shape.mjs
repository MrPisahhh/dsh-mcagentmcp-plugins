/**
 * 在 Node 里模拟浏览器的 `window.__ModuleLoader__`，加载 lib/client.js，
 * 检查插件导出形状与 apply() 的槽位注册是否符合官方约定。
 *
 * 抓的是「bundle 语法错 / 导出缺失 / 注册参数写错 / 组件渲染抛错」这类
 * 会让左侧栏入口不出现的问题。
 *
 * 用法：node test/client-shape.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

let failures = 0;
let checks = 0;

/** 记一条断言。 */
function check(ok, label, detail) {
  checks++;
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 最小 React 替身。 */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useId: () => 'id',
  Fragment: 'Fragment',
};

const registrations = [];
const injections = [];

const fakeCtx = {
  slots: {
    inject(name, callback) {
      injections.push(name);
      return callback();
    },
    register(options, Component) {
      registrations.push({ options, Component });
      return () => {};
    },
  },
};

let loaded;
const sandbox = {
  console,
  fetch: () => Promise.reject(new Error('no network in shape test')),
  setTimeout,
  clearTimeout,
  window: {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id, factory };
      },
    },
  },
  document: { createElement: () => ({ dataset: {}, appendChild: () => {} }), head: { appendChild: () => {} } },
};

console.log('[1] 加载 bundle');
const source = fs.readFileSync(CLIENT, 'utf8');
try {
  vm.runInNewContext(source, sandbox, { filename: CLIENT });
  check(true, '脚本执行无异常');
} catch (error) {
  check(false, '脚本执行无异常', error.message);
  process.exit(1);
}

check(loaded !== undefined, '调用了 window.__ModuleLoader__.load');
check(loaded?.id === 'dsh-agentmcp', 'bundle id 是 dsh-agentmcp', loaded?.id);

console.log('\n[2] factory 与导出');
const requireShim = (name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' };
  throw new Error(`unexpected require: ${name}`);
};

let mod;
try {
  mod = loaded.factory(requireShim);
  check(true, 'factory 执行无异常');
} catch (error) {
  check(false, 'factory 执行无异常', error.message);
  process.exit(1);
}

check(typeof mod.apply === 'function', '导出 apply');
check(Array.isArray(mod.inject) && mod.inject.includes('slots'), "inject 含 'slots'", mod.inject);

console.log('\n[3] apply 注册的槽位');
try {
  mod.apply(fakeCtx);
  check(true, 'apply 执行无异常');
} catch (error) {
  check(false, 'apply 执行无异常', error.message);
}

check(injections.includes('main'), "注入 'main'");
check(injections.includes('sidebar.panellist'), "注入 'sidebar.panellist'");

const mainReg = registrations.find((row) => row.options.name === 'main');
const iconReg = registrations.find((row) => row.options.name === 'sidebar.panellist');

check(mainReg !== undefined, '注册了 main 面板');
check(iconReg !== undefined, '注册了左侧栏图标');
check(mainReg?.options.key === 'agentmcp', "main.key === 'agentmcp'", mainReg?.options.key);
check(iconReg?.options.id === 'agentmcp', "panellist.id === 'agentmcp'", iconReg?.options.id);
check(mainReg?.options.key === iconReg?.options.id, '两者 id 一致（点图标能切过去）', {
  key: mainReg?.options.key,
  id: iconReg?.options.id,
});
check(typeof mainReg?.Component === 'function', 'main 有组件');
check(typeof iconReg?.Component === 'function', '图标有组件');
check(typeof iconReg?.options.label === 'function', '图标 label 是 thunk');
check(typeof iconReg?.options.order === 'number', '图标有 order');

console.log('\n[4] 组件能渲染不抛错');
try {
  check(mainReg.Component({}) !== undefined, '主面板组件返回元素');
} catch (error) {
  check(false, '主面板组件能渲染', error.message);
}
try {
  check(iconReg.Component({ size: 16, active: false }) !== undefined, '图标组件返回元素');
} catch (error) {
  check(false, '图标组件能渲染', error.message);
}

console.log('\n[5] 面板引用的接口前缀');
check(source.includes('/dsh-agentmcp/api'), 'client.js 引用 /dsh-agentmcp/api');

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
