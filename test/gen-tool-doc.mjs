/**
 * 从 Java ToolRegistry.java 生成 Markdown 工具清单。
 *
 * 用途：
 *   - 生成 SKILL.md 更新稿（放到 Dsh-Plugins 内，不碰原文件）
 *   - 给 README 提供最新的工具数与分组
 *
 * 用法：
 *   node test/gen-tool-doc.mjs --out <输出文件> [--title "标题"]
 *   node test/gen-tool-doc.mjs --print             # 只打印到 stdout
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolCatalog, parseSchema, groupByCategory, CATEGORY_LABELS } from '../lib/tool-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 读 `--name value` 形式的参数。 */
function opt(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const tools = loadToolCatalog();
const groups = groupByCategory(tools);
const title = opt('--title', 'AgentMCP 工具清单');
const outFile = opt('--out', '');
const printOnly = process.argv.includes('--print');

/**
 * 把 schema 的顶层参数压成一行简述。
 * @param schema - inputSchema。
 * @returns 例如 `x, y, z（必填 x, y, z）`。
 */
function paramsBrief(schema) {
  const props = schema?.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) return '无参数';
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const rendered = keys.map((key) => {
    const spec = props[key] ?? {};
    const type = spec.type ?? '?';
    const enumNote = Array.isArray(spec.enum) ? `=${spec.enum.join('/')}` : '';
    const requiredNote = required.includes(key) ? '*' : '';
    return `\`${key}${requiredNote}\`:${type}${enumNote}`;
  });
  return rendered.join(', ');
}

/** 生成 Markdown。 */
const lines = [];
lines.push(`# ${title}`, '');
lines.push(`> 由 \`Dsh-Plugins/dsh-agentmcp/test/gen-tool-doc.mjs\` 从 \`src/main/java/com/agentmcp/mcp/ToolRegistry.java\` 自动生成，共 **${tools.length}** 个工具。`, '');
lines.push('参数后带 `*` 表示必填。完整描述与约束请以模组源码和 `tools/list` 返回为准。', '');

for (const [key, rows] of groups) {
  const label = CATEGORY_LABELS[key] ?? key;
  lines.push(`## ${label}（${rows.length}）`, '');
  lines.push('| 工具 | 参数 | 说明 |', '|---|---|---|');
  for (const tool of rows) {
    const schema = parseSchema(tool.schema);
    const desc = String(tool.description ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
    // 表格里描述截断到 160 字，避免一行过长。
    const short = desc.length > 160 ? `${desc.slice(0, 157)}…` : desc;
    lines.push(`| \`${tool.name}\` | ${paramsBrief(schema)} | ${short} |`);
  }
  lines.push('');
}

const markdown = `${lines.join('\n')}\n`;

if (outFile) {
  const dest = path.resolve(outFile);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, markdown, 'utf8');
  console.log(`written: ${dest} (${tools.length} tools, ${groups.size} groups)`);
}
if (printOnly || !outFile) process.stdout.write(markdown);
