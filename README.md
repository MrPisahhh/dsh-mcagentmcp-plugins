# dsh-agentmcp

把本仓库的 **AgentMCP 模组**（Fabric / Minecraft）接进 DeepSeek Harness：
左侧栏一个「AgentMCP」入口，点开能看到连接状态、游戏内状态、按分类分组且可搜索的
工具目录，并能改配置、连接 / 断开、把计划推到游戏 HUD、试调一个工具。模型侧则拿到
`mcp__agentmcp__<tool>` 这一整套游戏操作工具。

**工具数量不写死**：插件启动时通过 `tools/list` 动态发现服务端工具（当前 55 个），
面板的工具目录由 `lib/tool-catalog.mjs` 从 Java 源码解析，测试里的数量断言也从源码读取。
模组再加工具，插件和假服务器自动跟上，不用改一行数字。

## 为什么不用 `@deepseek-ai/dsh-mcp-client`

这个插件**自带一个极简 MCP 客户端**，只用 node 内置模块 + 全局 `fetch`，零运行时依赖。

原因：DSH 的 profile 解析层只路由**显式声明为依赖**的包，而
`@deepseek-ai/dsh-mcp-client` 是安装自带包；从以 `link:` 装进来的插件里裸
`import(...)` 会 `ERR_MODULE_NOT_FOUND`。自己实现一个反而最稳 —— 而且这个服务端
协议很窄：**只收 POST JSON-RPC 2.0，不支持 SSE / GET**，用不着完整 MCP SDK。

协议要点（见 `src/main/java/com/agentmcp/mcp/McpServer.java`）：

| 项 | 值 |
|---|---|
| 传输 | Streamable HTTP，仅 POST JSON-RPC 2.0 |
| MCP 端点 | `http://127.0.0.1:25566/mcp` |
| 健康检查 | `GET /health` → `ok / in_game / player / port / tools` |
| 协议版本 | `2025-06-18`（服务端原样回显） |
| 单次调用上限 | **95 秒**，超时服务端强制停动作 |
| 鉴权 | `config/agentmcp.json` 的 `authToken` 非空时，所有请求需 `Authorization: Bearer <token>` |
| 返回格式 | `content[0].text` 是**再包一层**的 JSON 字符串，`isError` 表示失败 |

## 用法

打开 DSH Web GUI → 左侧栏点「AgentMCP」（草方块图标）。

- **状态卡**：是否连上、`/health` 是否可达、玩家是否在世界里、端口、服务端工具数，
  外加一行**诊断提示**（区分「模组没启动」「在主菜单」「已就绪但没连」）。
- **配置**：可改 URL、serverName、Bearer 令牌、单次超时、开机自动连接。
  改动会立刻重连；连不上且改动涉及 URL/名字/令牌时**自动回滚并恢复原连接**，
  不留坏配置、也不因一次失败保存而掉线。
- **连接 / 断开 / 重连**：断开会立刻注销所有 `mcp__agentmcp__*` 工具。
- **工具目录**：按源码分类分组、可搜索；点工具名直接填入「试一下」。
  每个工具显示真实描述和参数 schema，参数框会自动生成模板。
- **HUD 任务列表**：写几行计划，一键通过 `set_task_list` 推到游戏内 HUD。
- **试一下**：选一个工具、填 JSON 参数，直接发一次 `tools/call` 看返回。

模型侧还有一个 `agentmcp_bridge` 工具（`action=status|connect|disconnect|reconnect`），
即使 MCP 没连上也能自查 —— 当 `mcp__agentmcp__*` 工具消失时用它。

工具清单见 [`AgentUseMCPSkill/SKILL.md`](../../AgentUseMCPSkill/SKILL.md)。
⚠️ 那份文档目前写的是 36 个工具，已过期；按你的约束我没有改它，
而是在 [`../SKILL.md.update-for-55-tools.md`](../SKILL.md.update-for-55-tools.md)
放了一份从源码自动生成的 55 工具更新稿，确认后可手动合并。

## 配置

`cordis.patch.yml` 里的 `config` 可覆盖默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `serverName` | `agentmcp` | 工具名前缀，决定 `mcp__agentmcp__*` |
| `url` | `http://127.0.0.1:25566/mcp` | MCP 端点 |
| `authToken` | `''` | 与模组 `config/agentmcp.json` 一致 |
| `toolCallTimeoutMs` | `90000` | 单次调用超时，上限 95000 |
| `autoStart` | `true` | DSH 启动时自动连接 |
| `statePath` | `~/.dsh/agentmcp/bridge.json` | 运行期覆盖项位置；也可用环境变量 `DSH_AGENTMCP_STATE` 覆盖 |

面板里改的覆盖项持久化在 `statePath`，优先级高于 patch 的 config。
写盘失败（目录只读等）不会让面板报错，但会在状态卡显示警告 —— 此时改动只在本次会话有效。
令牌**不会回填到面板**（避免明文出现在 DOM），留空即表示保持现有值。

## 实现要点

| 关注点 | 做法 |
|---|---|
| 工具目录 | `lib/tool-catalog.mjs` 从 Java `ToolRegistry.java` 解析工具名/描述/schema/分类，供 `/catalog` 与面板分组搜索用 |
| 动态数量 | 假服务器与测试都从 catalog 取数量，模组加工具自动跟上（已经历 28→36→42→55） |
| 工具注册 | `ctx.tools.register()`，`output: { schema, render }` 与官方 `createMcpToolDefinition` 对齐 |
| 断开即注销 | 保存每个工具返回的 disposer，`disconnect()` 统一回收 |
| 原子注册 | 先全部构造再注册，任一 schema 被拒就整批回滚，不留半个工具集 |
| 重连竞态 | `generation` 代次号；断开后慢完成的旧连接自废弃并摘掉刚注册的工具 |
| 提示词 | `systemPrompt.section()` **只注册一次**，`text()` 动态读当前连接；未连接时为空 |
| 服务时序 | 路由包在 `ctx.inject(['webServer'], ...)` 里，不假设 webServer 已就绪 |
| 失败可感知 | 显式 `probeHealth()` + 握手 / tools/list 分阶段报错；`/state` 带 `diagnosis` 分级提示 |
| 保存失败 | 回滚配置并**恢复原连接**；写盘失败降级为内存态并在面板警告 |

### 关于 HMR

DSH 的 HMR 默认 `root: []`，**只监视 profile 的 patch 文件和 package.json**。
改了本插件的 `lib/*.js` 不会自动重载 —— 需要触发一次 profile 重组
（改一下 `cordis.patch.yml` 再存盘），或重启 DSH。

## 自测

```sh
# 1) client bundle 形状（不需要 DSH 运行）
node test/client-shape.mjs

# 2) 用假 MCP 服务器端到端测 host 半边（不需要 Minecraft，不写用户目录）
node test/smoke.mjs

# 3) 从 Java 源码生成最新工具清单（SKILL.md 更新稿就来自它）
node test/gen-tool-doc.mjs --print
```

`test/fake-agentmcp.mjs` 是一个模拟 Java 端协议的假服务器（POST-only JSON-RPC、
`/health`、从源码读取的全部工具定义），所以**不用开 Minecraft 也能验证整条链路**。

## 安装

```sh
# 1) 链接进 profile（~/.dsh/profiles/<profile>/package.json）
#    dependencies 加：
#      "dsh-agentmcp": "link:D:/Computer/DE/MyCode/McAgentMCP/Dsh-Plugins/dsh-agentmcp"
#    dsh.profile.bundles 加：
#      "dsh-agentmcp"
pnpm install

# 2) 重启 DSH，或触发一次 profile 重组
```

`dsh.bundle.patch` 会让安装器自动插入：

```yaml
- insert:
    - id: agentmcp
      name: dsh-agentmcp
      config: {}
```

## License

MIT
