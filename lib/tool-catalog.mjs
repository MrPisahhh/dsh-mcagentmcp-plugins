/**
 * 从 Java 源码解析 AgentMCP 的工具清单。
 *
 * 为什么要动态解析：模组每加一个工具，插件里写死的数字和清单就会过期
 * （本项目已经从 28 → 36 → 42 → 55 变了四次）。这个模块读
 * `src/main/java/com/agentmcp/mcp/ToolRegistry.java`，把
 * `register("name", """description""", """schema""", handler)` 里的前三项抽出来，
 * 插件、假服务器、测试、文档都从这里取，一处更新处处生效。
 *
 * 只依赖 node 内置模块，浏览器半边不加载它。
 *
 * @module dsh-agentmcp/tool-catalog
 */

import fs from 'node:fs';
import path from 'node:path';

/** 本插件在仓库里的位置：Dsh-Plugins/dsh-agentmcp/test → 仓库根 = 上三级。 */
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');

/** ToolRegistry.java 的默认位置。 */
const DEFAULT_SOURCE = path.join(
  REPO_ROOT,
  'src', 'main', 'java', 'com', 'agentmcp', 'mcp', 'ToolRegistry.java',
);

/**
 * 用状态机抽出每个 register() 调用的前三个参数：名字、描述、schema。
 *
 * Java 用 text block (`"""`) 包描述和 schema，所以我们只需找到
 * `register("` 开头，然后依次读：普通字符串 → text block → text block。
 * handler 是 lambda，不解析。
 *
 * @param source - Java 源码全文。
 * @returns `{ name, description, schema, category }[]`。
 */
function parseRegistrations(source) {
  const tools = [];
  const lines = source.split(/\r?\n/);
  let category = 'general';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 记录分组：registerObservationTools() 等私有方法名决定分类。
    // 要排除 L61 的 `private static void register(String name, ...)` 定义本身。
    const group = /private static void register([A-Z]\w*)Tools\(\)/.exec(line);
    if (group) {
      category = group[1].replace(/Tools$/, '').toLowerCase();
      continue;
    }

    const match = /^\s*register\("([a-z_0-9]+)"/.exec(line);
    if (!match) continue;

    const name = match[1];
    const description = readTextBlock(lines, i);
    // 描述与 schema 的 `"""` 常常写在同一行（`""", """`），所以第二个块要从
    // 描述结束行**本身**开始找，而不是 +1，否则会错过并串到下一个工具。
    const schema = readTextBlock(lines, i, description.endLine);

    tools.push({
      name,
      description: description.text.trim(),
      schema: schema.text.trim(),
      category,
    });
    // 只跳到 schema 结束行，别跳过分组方法的边界。
    i = Math.max(i, schema.endLine);
  }
  return tools;
}

/**
 * 从 startLine 往后找第一个 `"""` text block 并读出内容。
 * @param lines - 源码行数组。
 * @param startLine - 起始行。
 * @param fromLine - 可选：从这行开始找（用于读第二个 text block）。
 * @returns `{ text, endLine }`；找不到返回空串。
 */
function readTextBlock(lines, startLine, fromLine = startLine) {
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 80); i += 1) {
    const open = lines[i].indexOf('"""');
    if (open < 0) continue;

    // 同一行可能既有上一个块的闭合 `"""` 又有本块的开启 `"""`
    // （Java 里常见写法：`""", """`）。取最后一个 `"""` 作为本块的开启。
    const lastOpen = lines[i].lastIndexOf('"""');
    const parts = [lines[i].slice(lastOpen + 3)];

    // 若本行在开启之后立刻又闭合了，直接返回。
    const closeSameLine = lines[i].indexOf('"""', lastOpen + 3);
    if (closeSameLine >= 0) {
      parts[0] = lines[i].slice(lastOpen + 3, closeSameLine);
      return { text: parts.join('\n'), endLine: i };
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const close = lines[j].indexOf('"""');
      if (close >= 0) {
        parts.push(lines[j].slice(0, close));
        return { text: parts.join('\n'), endLine: j };
      }
      parts.push(lines[j]);
    }
    return { text: parts.join('\n'), endLine: lines.length - 1 };
  }
  return { text: '', endLine: startLine };
}

/**
 * 读工具清单。
 * @param options - `{ sourcePath }`，缺省读仓库里的 ToolRegistry.java。
 * @returns 工具数组（含 name / description / schema / category）。
 */
export function loadToolCatalog(options = {}) {
  const sourcePath = options.sourcePath ?? process.env.AGENTMCP_TOOL_SOURCE ?? DEFAULT_SOURCE;
  let source;
  try {
    source = fs.readFileSync(sourcePath, 'utf8');
  } catch (error) {
    throw new Error(`读不到 ToolRegistry.java：${sourcePath}（${error.message}）`);
  }
  const tools = parseRegistrations(source);
  if (tools.length === 0) {
    throw new Error(`ToolRegistry.java 里没解析到任何 register(...) 调用：${sourcePath}`);
  }
  return tools;
}

/**
 * 把 Java 的 `"""` text block 里的 schema 字符串解析成 JSON Schema 对象。
 * 模组里的 schema 都是合法 JSON，解析失败时退回最简 object。
 * @param raw - schema 文本。
 * @returns JSON Schema 对象。
 */
export function parseSchema(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { type: 'object', properties: {} };
  } catch {
    return { type: 'object', properties: {} };
  }
}

/**
 * 按分类给工具分组，供面板展示。
 * @param tools - loadToolCatalog() 的结果。
 * @returns `Map<category, tools[]>`，保持 Java 里出现的顺序。
 */
export function groupByCategory(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const bucket = groups.get(tool.category);
    if (bucket) bucket.push(tool);
    else groups.set(tool.category, [tool]);
  }
  return groups;
}

/** 分类的中文名（面板用）。 */
export const CATEGORY_LABELS = Object.freeze({
  observation: '观察',
  movement: '移动',
  interaction: '交互',
  inventory: '背包与状态',
  utility: '工具与系统',
  advanced: '高级操作',
  natural: '自然化操作',
  general: '其它',
});

export { DEFAULT_SOURCE, REPO_ROOT };
