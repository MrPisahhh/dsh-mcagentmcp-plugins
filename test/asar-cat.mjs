/**
 * 从 app.asar 里读一个文件并打印，或按正则打印命中行的上下文。不落盘、不需要解压整个包。
 *
 * 用法：
 *   node test/asar-cat.mjs <asar路径> <包内路径> [正则]
 * 例：
 *   node test/asar-cat.mjs "D:\...\app.asar" dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js "register\("
 */
import fs from 'node:fs';

const [, , asarPath, internalPath, pattern] = process.argv;
if (!asarPath || !internalPath) {
  console.error('用法：node test/asar-cat.mjs <asar路径> <包内路径> [正则]');
  process.exit(2);
}

const buf = fs.readFileSync(asarPath);
const jsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'));
const baseOffset = 8 + buf.readUInt32LE(4);

let node = header;
for (const seg of internalPath.split('/').filter(Boolean)) {
  node = node?.files?.[seg];
  if (!node) {
    console.error(`包内找不到：${internalPath}`);
    process.exit(1);
  }
}
if (node.files) {
  console.error('那是目录');
  process.exit(1);
}
if (node.unpacked) {
  console.error('该条目是 unpacked 的，去 app.asar.unpacked 读');
  process.exit(1);
}

const start = baseOffset + Number(node.offset);
const text = buf.subarray(start, start + node.size).toString('utf8');

if (!pattern) {
  process.stdout.write(text);
  process.exit(0);
}

const re = new RegExp(pattern);
const lines = text.split('\n');
let hits = 0;
for (let i = 0; i < lines.length; i++) {
  if (!re.test(lines[i])) continue;
  hits++;
  const from = Math.max(0, i - 5);
  const to = Math.min(lines.length - 1, i + 10);
  console.log(`--- line ${i + 1} ---`);
  for (let j = from; j <= to; j++) console.log(`${String(j + 1).padStart(5)} | ${lines[j]}`);
}
console.log(`--- ${hits} 处命中 / 共 ${lines.length} 行 ---`);
