/**
 * dsh-agentmcp —— 浏览器半边。
 *
 * 两件事：
 *   1. 往左侧栏的 `sidebar.panellist` 塞一个入口图标（草方块）；
 *   2. 往 `main` 键控槽注册同 id 的面板，点图标就切过去。
 *
 * 面板只跟自己的同源接口 `/dsh-agentmcp/api/*` 说话，不碰 DSH 内部服务。
 * 模块格式跟官方 client 插件一致：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 里只用宿主注入的 require（react）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agentmcp',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    /** 面板 id：左侧栏入口和 main 面板必须用同一个 id 才能对上。 */
    const PANEL_ID = 'agentmcp';
    /** 后端路由前缀。 */
    const API = '/dsh-agentmcp/api';

    /* ───────────────────────── 样式 ───────────────────────── */

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '24px 28px 48px',
        height: '100%',
        overflowY: 'auto',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        fontSize: 13,
        lineHeight: 1.5,
      },
      header: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: '28px' },
      subtitle: { margin: '2px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8c959f)' },
      spacer: { flex: 1 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
        borderRadius: 8,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      name: { fontWeight: 600, fontSize: 14 },
      badge: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 10,
        border: '1px solid currentColor',
        opacity: 0.85,
      },
      muted: { color: 'var(--dsw-alias-label-tertiary, #8c959f)', fontSize: 12 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        wordBreak: 'break-all',
      },
      btn: {
        font: 'inherit',
        fontSize: 12,
        padding: '4px 12px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18))',
        background: 'transparent',
        color: 'inherit',
      },
      btnPrimary: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 14px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-business-primary, #0969da)',
        background: 'var(--dsw-alias-state-business-primary, #0969da)',
        color: '#fff',
        fontWeight: 500,
      },
      btnDanger: { color: 'var(--dsw-alias-state-error-primary, #cf222e)' },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e7781)' },
      input: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02))',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      textarea: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02))',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
        resize: 'vertical',
      },
      grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
      notice: { fontSize: 12, padding: '6px 10px', borderRadius: 6 },
      dot: { width: 7, height: 7, borderRadius: 4, display: 'inline-block' },
      toolList: { display: 'flex', flexWrap: 'wrap', gap: 5 },
      tool: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      pre: {
        margin: 0,
        padding: 10,
        maxHeight: 260,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04))',
        borderRadius: 6,
      },
    };

    /* ───────────────────────── 网络 ───────────────────────── */

    /**
     * 统一 fetch：网络错误、非 2xx、以及 200 里的 ok:false 都收敛成 { ok, message }。
     * @param path - 相对 API 的路径。
     * @param body - 有值则 POST JSON。
     * @returns `{ ok, message?, data? }`。
     */
    async function call(path, body) {
      try {
        const init = body === undefined
          ? undefined
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            };
        const res = await fetch(API + path, init);
        let payload = null;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        if (!res.ok || (payload && payload.ok === false)) {
          return { ok: false, message: (payload && payload.message) || `HTTP ${res.status}`, data: payload };
        }
        return { ok: true, data: payload };
      } catch (error) {
        return { ok: false, message: `读不到：${error && error.message ? error.message : error}` };
      }
    }

    /* ───────────────────────── 小部件 ───────────────────────── */

    /**
     * 状态点。
     * @param props - `{ ok }`。
     */
    function StatusDot({ ok }) {
      return h('span', {
        style: {
          ...S.dot,
          background: ok
            ? 'var(--dsw-alias-state-success-primary, #1a7f37)'
            : 'var(--dsw-alias-label-tertiary, #8c959f)',
        },
      });
    }

    /**
     * 一行「标签 + 输入框」。
     * @param props - `{ label, value, onChange, placeholder, type, disabled }`。
     */
    function Field({ label, value, onChange, placeholder, type, disabled }) {
      return h(
        'label',
        { style: S.field },
        h('span', { style: S.label }, label),
        h('input', {
          style: S.input,
          type: type || 'text',
          value: value == null ? '' : value,
          placeholder: placeholder || '',
          disabled: Boolean(disabled),
          onChange: (event) => onChange(event.target.value),
        }),
      );
    }

    /* ───────────────────────── 配置表单 ───────────────────────── */

    /**
     * 从 state 生成表单草稿。
     * @param state - /state 的返回。
     */
    function draftFromState(state) {
      return {
        url: state?.url || 'http://127.0.0.1:25566/mcp',
        serverName: state?.serverName || 'agentmcp',
        authToken: '', // 从不回填令牌，只在用户主动输入时提交
        toolCallTimeoutMs: String(state?.toolCallTimeoutMs ?? 90000),
        autoStart: state?.autoStart !== false,
      };
    }

    /**
     * 配置表单。
     * @param props - `{ draft, onChange, onSubmit, busy }`。
     */
    function ConfigEditor({ draft, onChange, onSubmit, busy }) {
      const set = (key) => (value) => onChange({ ...draft, [key]: value });
      return h(
        'div',
        { style: { ...S.card, gap: 12 } },
        h(
          'div',
          { style: S.grid2 },
          h(Field, {
            label: 'MCP 端点 URL',
            value: draft.url,
            onChange: set('url'),
            placeholder: 'http://127.0.0.1:25566/mcp',
          }),
          h(Field, {
            label: '工具名前缀（serverName）',
            value: draft.serverName,
            onChange: set('serverName'),
            placeholder: 'agentmcp',
          }),
        ),
        h(
          'div',
          { style: S.grid2 },
          h(Field, {
            label: 'Bearer 令牌（留空表示不修改）',
            value: draft.authToken,
            onChange: set('authToken'),
            placeholder: '留空 = 保持现有值',
            type: 'password',
          }),
          h(Field, {
            label: '单次调用超时（毫秒，≤ 95000）',
            value: draft.toolCallTimeoutMs,
            onChange: (value) => set('toolCallTimeoutMs')(value.replace(/[^0-9]/g, '')),
            type: 'text',
          }),
        ),
        h(
          'label',
          { style: { ...S.row, fontSize: 12.5 } },
          h('input', {
            type: 'checkbox',
            checked: draft.autoStart,
            onChange: (event) => set('autoStart')(event.target.checked),
          }),
          'DSH 启动时自动连接',
        ),
        h(
          'div',
          { style: { ...S.row, justifyContent: 'flex-end' } },
          h(
            'button',
            {
              type: 'button',
              style: S.btnPrimary,
              disabled: busy,
              onClick: () => {
                const payload = {
                  url: draft.url,
                  serverName: draft.serverName,
                  toolCallTimeoutMs: Number(draft.toolCallTimeoutMs) || 90000,
                  autoStart: draft.autoStart,
                };
                // 令牌留空时不提交，避免把已保存的令牌清掉。
                if (draft.authToken.trim()) payload.authToken = draft.authToken.trim();
                onSubmit(payload);
              },
            },
            busy ? '保存中…' : '保存并重新连接',
          ),
        ),
      );
    }

    /* ───────────────────────── 试一下 ───────────────────────── */

    /**
     * 从 JSON Schema 生成一个「参数模板」，方便人类照着填。
     * 只处理顶层 properties：没有默认值的给类型占位，有 enum 的取第一个。
     * @param schema - 工具的 inputSchema。
     * @returns 可直接编辑的 JSON 字符串。
     */
    function schemaTemplate(schema) {
      const props = schema?.properties;
      if (!props || typeof props !== 'object') return '{}';
      const out = {};
      for (const [key, spec] of Object.entries(props)) {
        if (Array.isArray(spec?.enum) && spec.enum.length > 0) out[key] = spec.enum[0];
        else if (spec?.type === 'number' || spec?.type === 'integer') out[key] = 0;
        else if (spec?.type === 'boolean') out[key] = false;
        else if (spec?.type === 'array') out[key] = [];
        else if (spec?.type === 'object') out[key] = {};
        else out[key] = '';
      }
      return Object.keys(out).length > 0 ? JSON.stringify(out, null, 2) : '{}';
    }

    /**
     * 工具调用测试区（受控：toolName / setToolName 由主面板持有，点工具目录可直接填入）。
     * @param props - `{ state, catalog, busy, onCall, toolName, setToolName }`。
     */
    function TryCall({ state, catalog, busy, onCall, toolName, setToolName }) {
      const tools = state?.tools ?? [];
      const byName = React.useMemo(() => {
        const map = new Map();
        for (const tool of catalog?.tools ?? []) map.set(tool.name, tool);
        return map;
      }, [catalog]);
      const [argsText, setArgsText] = React.useState('{}');

      React.useEffect(() => {
        if (tools.length > 0 && !tools.includes(toolName)) setToolName(tools[0]);
      }, [tools.join(',')]);

      // 换工具时把参数框换成该工具的模板。
      React.useEffect(() => {
        const tool = byName.get(toolName);
        setArgsText(schemaTemplate(tool?.schema));
      }, [toolName, byName]);

      const detail = byName.get(toolName);

      return h(
        'div',
        { style: { ...S.card, gap: 10 } },
        h('div', { style: S.name }, '试一下'),
        h(
          'div',
          { style: S.row },
          h(
            'select',
            {
              style: { ...S.input, width: 'auto', minWidth: 180 },
              value: toolName,
              disabled: busy || tools.length === 0,
              onChange: (event) => setToolName(event.target.value),
            },
            tools.length === 0
              ? h('option', { value: '' }, '（未连接）')
              : tools.map((name) => h('option', { key: name, value: name }, name)),
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.btnPrimary,
              disabled: busy || !state?.connected || !toolName,
              onClick: () => {
                let args = {};
                try {
                  args = argsText.trim() ? JSON.parse(argsText) : {};
                } catch (error) {
                  onCall(null, null, `参数不是合法 JSON：${error.message}`);
                  return;
                }
                onCall(toolName, args, null);
              },
            },
            busy ? '调用中…' : '调用',
          ),
        ),
        detail?.description &&
          h('div', { style: { ...S.muted, whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, detail.description),
        h('textarea', {
          style: S.textarea,
          rows: 4,
          value: argsText,
          onChange: (event) => setArgsText(event.target.value),
          placeholder: '{"x": 1, "z": 2}',
          'aria-label': '工具参数 JSON',
        }),
      );
    }

    /* ───────────────────────── 工具浏览器 ───────────────────────── */

    /**
     * 按分类分组的工具列表，带搜索。55 个工具平铺没法用，分组 + 搜索才找得到。
     * @param props - `{ catalog, tools, onPick }`。
     */
    function ToolBrowser({ catalog, tools, onPick }) {
      const [query, setQuery] = React.useState('');
      const [open, setOpen] = React.useState(true);
      const registered = React.useMemo(() => new Set(tools ?? []), [tools]);
      const byName = React.useMemo(() => {
        const map = new Map();
        for (const tool of catalog?.tools ?? []) map.set(tool.name, tool);
        return map;
      }, [catalog]);

      const q = query.trim().toLowerCase();
      const groups = (catalog?.groups ?? []).map((group) => ({
        ...group,
        tools: group.tools.filter((name) => {
          if (!q) return true;
          const tool = byName.get(name);
          return name.includes(q) || String(tool?.description ?? '').toLowerCase().includes(q);
        }),
      })).filter((group) => group.tools.length > 0);

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h(
            'button',
            { type: 'button', style: { ...S.btn, padding: '2px 8px' }, onClick: () => setOpen(!open) },
            open ? '▾' : '▸',
          ),
          h('span', { style: S.name }, `工具目录（${catalog?.count ?? 0}）`),
          h('span', { style: S.spacer }),
          h('input', {
            style: { ...S.input, width: 180 },
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: '搜索工具或描述…',
            'aria-label': '搜索工具',
          }),
        ),
        open &&
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            groups.length === 0 && h('div', { ...S.muted }, q ? '没有匹配的工具' : '目录为空（Java 源码不可读？）'),
            groups.map((group) =>
              h(
                'div',
                { key: group.key },
                h('div', { style: { ...S.label, marginBottom: 4 } }, `${group.label} · ${group.tools.length}`),
                h(
                  'div',
                  { style: S.toolList },
                  group.tools.map((name) =>
                    h(
                      'button',
                      {
                        key: name,
                        type: 'button',
                        title: String(byName.get(name)?.description ?? '').slice(0, 300),
                        onClick: () => onPick?.(name),
                        style: {
                          ...S.tool,
                          font: 'inherit',
                          cursor: onPick ? 'pointer' : 'default',
                          border: '1px solid transparent',
                          opacity: registered.has(name) ? 1 : 0.5,
                          color: registered.has(name) ? 'inherit' : 'var(--dsw-alias-label-tertiary, #8c959f)',
                        },
                      },
                      name,
                    ),
                  ),
                ),
              ),
            ),
            h('div', { ...S.muted }, '暗色 = 当前未注册（未连接，或服务端未列出）；点名称可填入「试一下」。'),
          ),
      );
    }

    /* ───────────────────────── HUD 任务列表 ───────────────────────── */

    /**
     * 把计划推到游戏内 HUD（模组 set_task_list）。
     * 模组只提供写入、没有读取接口，所以这里是个编辑器而不是「当前列表」视图。
     * @param props - `{ connected, busy, onPush }`。
     */
    function TaskListEditor({ connected, busy, onPush }) {
      const [open, setOpen] = React.useState(false);
      const [text, setText] = React.useState('观察周围\n走向目标\n采集资源');
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h(
            'button',
            { type: 'button', style: { ...S.btn, padding: '2px 8px' }, onClick: () => setOpen(!open) },
            open ? '▾' : '▸',
          ),
          h('span', { style: S.name }, 'HUD 任务列表'),
          h('span', { style: S.spacer }),
          h('span', { ...S.muted }, `${lines.length} 条 · 显示在游戏 HUD`),
        ),
        open &&
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', { ...S.muted }, '每行一条任务，最多 12 条、每条 80 字。推送会替换 HUD 上的整个列表；状态默认 pending，可用 `status:done` 之类前缀……当前版本统一按 pending 推送。'),
            h('textarea', {
              style: S.textarea,
              rows: 5,
              value: text,
              onChange: (event) => setText(event.target.value),
              'aria-label': 'HUD 任务列表内容',
            }),
            h(
              'div',
              { style: { ...S.row, justifyContent: 'flex-end' } },
              h(
                'button',
                {
                  type: 'button',
                  style: S.btnPrimary,
                  disabled: busy || !connected || lines.length === 0,
                  onClick: () => onPush(lines.map((line) => ({ text: line, status: 'pending' }))),
                },
                busy ? '推送中…' : '推送到 HUD',
              ),
            ),
          ),
      );
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    /**
     * 主面板：连接状态 + 配置 + 工具列表 + 试调用。
     */
    function AgentMcpPage() {
      const [state, setState] = React.useState(null);
      const [catalog, setCatalog] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [callResult, setCallResult] = React.useState(null);
      const [tryTool, setTryTool] = React.useState('get_status');

      /** 拉一次状态。 */
      const refresh = React.useCallback(async () => {
        const result = await call('/state');
        if (result.ok) {
          setState(result.data);
          setError(null);
        } else {
          setError(result.message);
        }
      }, []);

      React.useEffect(() => {
        void refresh();
        void call('/catalog').then((result) => {
          if (result.ok) setCatalog(result.data);
        });
      }, [refresh]);

      /** 跑一个会改状态的动作。 */
      const run = React.useCallback(async (path, body) => {
        setBusy(true);
        setNotice(null);
        try {
          const result = await call(path, body);
          if (result.data) setState(result.data);
          setNotice({ ok: result.ok, text: result.ok ? (result.data?.message || '完成') : result.message });
        } finally {
          setBusy(false);
        }
      }, []);

      /** 试调用一个工具。 */
      const tryCall = React.useCallback(async (tool, args, parseError) => {
        if (parseError) {
          setCallResult({ ok: false, text: parseError });
          return;
        }
        setBusy(true);
        setCallResult({ ok: true, text: '调用中…' });
        try {
          const result = await call('/call', { tool, arguments: args });
          const data = result.data ?? {};
          const text = data.text ?? (data.ok === false ? data.message : JSON.stringify(data));
          setCallResult({
            ok: result.ok,
            text: `${String(text ?? '')}${data.elapsedMs !== undefined ? `\n\n耗时 ${data.elapsedMs} ms` : ''}`,
          });
          if (!result.ok) setNotice({ ok: false, text: result.message });
        } finally {
          setBusy(false);
        }
      }, []);

      /** 推送 HUD 任务列表。 */
      const pushTasks = React.useCallback(async (tasks) => {
        setBusy(true);
        try {
          const result = await call('/task-list', { tasks });
          setNotice({ ok: result.ok, text: result.ok ? (result.data?.message || '已推送') : result.message });
        } finally {
          setBusy(false);
        }
      }, []);

      const connected = Boolean(state?.connected);
      const health = state?.health;
      const tools = state?.tools ?? [];
      const inGame = health?.ok === true && health?.in_game === true;
      const diagnosis = state?.diagnosis;

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.header },
          h(
            'div',
            null,
            h('h1', { style: S.title }, 'AgentMCP · Minecraft'),
            h(
              'p',
              { style: S.subtitle },
              state ? `${state.serverName} · ${state.url}` : '正在读取…',
            ),
          ),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void refresh() }, '刷新'),
          h(
            'button',
            {
              type: 'button',
              style: S.btn,
              disabled: busy,
              onClick: () => setDraft(draft ? null : draftFromState(state)),
            },
            draft ? '收起配置' : '配置',
          ),
          connected
            ? h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void run('/disconnect', {}) }, '断开')
            : h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void run('/connect', {}) }, '连接'),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => void run('/reconnect', {}) }, '重连'),
        ),

        error && h('div', { style: { ...S.notice, color: 'var(--dsw-alias-state-error-primary, #cf222e)' } }, `读取失败：${error}`),
        notice &&
          h(
            'div',
            {
              style: {
                ...S.notice,
                color: notice.ok ? 'var(--dsw-alias-state-success-primary, #1a7f37)' : 'var(--dsw-alias-state-error-primary, #cf222e)',
              },
            },
            notice.text,
          ),

        draft &&
          h(ConfigEditor, {
            draft,
            onChange: setDraft,
            busy,
            onSubmit: async (payload) => {
              await run('/save', payload);
              setDraft(null);
            },
          }),

        // 状态卡
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h(StatusDot, { ok: connected }),
            h('span', { style: S.name }, connected ? '已连接' : '未连接'),
            h(
              'span',
              { style: { ...S.badge, color: connected ? 'var(--dsw-alias-state-success-primary, #1a7f37)' : 'inherit' } },
              `${state?.toolCount ?? 0} 个工具`,
            ),
            h('span', { style: S.spacer }),
            h('span', { style: S.muted }, state?.hasToken ? '已配置令牌' : '无令牌'),
          ),
          h(
            'div',
            { style: S.row },
            h(StatusDot, { ok: inGame }),
            h('span', { ...S.muted }, health?.ok
              ? `游戏内：${health.in_game ? '是' : '否'} · 玩家 ${health.player ?? '—'} · 端口 ${health.port ?? '—'} · 服务端工具 ${health.tools ?? '—'}`
              : `/health 不可达${health?.error ? `：${health.error}` : ''}`),
          ),
          diagnosis && h('div', {
            style: {
              ...S.notice,
              color: diagnosis.level === 'error'
                ? 'var(--dsw-alias-state-error-primary, #cf222e)'
                : diagnosis.level === 'warn'
                  ? 'var(--dsw-alias-state-warning-primary, #9a6700)'
                  : 'var(--dsw-alias-state-success-primary, #1a7f37)',
            },
          }, diagnosis.hint),
          state?.lastError && h('div', { style: { ...S.notice, color: 'var(--dsw-alias-state-error-primary, #cf222e)' } }, state.lastError),
          state?.stateError && h('div', { style: { ...S.notice, color: 'var(--dsw-alias-state-error-primary, #cf222e)' } }, `配置无法写入磁盘（重启后会丢失）：${state.stateError}`),
          state?.statePath && h('div', { style: { ...S.mono, ...S.muted } }, `配置：${state.statePath}`),
        ),

        // 工具目录：按分类分组 + 搜索，替代平铺 55 个名字。
        h(ToolBrowser, { catalog, tools, onPick: (name) => setTryTool(name) }),

        h(TaskListEditor, { connected, busy, onPush: pushTasks }),

        h(TryCall, {
          state,
          catalog,
          busy,
          onCall: tryCall,
          toolName: tryTool,
          setToolName: setTryTool,
        }),

        callResult &&
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.row },
              h('span', { style: S.name }, '调用结果'),
              h('span', { style: S.spacer }),
              h('button', { type: 'button', style: S.btn, onClick: () => setCallResult(null) }, '清除'),
            ),
            h('pre', {
              style: { ...S.pre, color: callResult.ok ? 'inherit' : 'var(--dsw-alias-state-error-primary, #cf222e)' },
            }, callResult.text),
          ),
      );
    }

    /* ───────────────────────── 左侧栏图标 ───────────────────────── */

    /**
     * 左侧栏入口图标（草方块）。
     * @param props - `{ size, active }`。
     */
    function AgentMcpIcon({ size }) {
      const edge = size || 16;
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2 5.5 8 2.5l6 3v5L8 13.5l-6-3v-5Z' }),
        h('path', { d: 'M2 5.5 8 8.5l6-3M8 8.5v5' }),
      );
    }

    /* ───────────────────────── 接线 ───────────────────────── */

    /**
     * 注册左侧栏入口与主面板。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, AgentMcpPage),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 6,
            label: () => 'AgentMCP',
          },
          AgentMcpIcon,
        ),
      );
    }

    exports.name = 'agentmcp-client';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
