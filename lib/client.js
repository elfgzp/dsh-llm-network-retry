/**
 * dsh-llm-network-retry —— 浏览器半边（崩溃恢复的确认条）。
 *
 * 只做一件事：当当前会话的日志以「进程被杀/崩溃导致的 interrupted 轮次」结尾时，
 * 在输入框下方显示一条提示，说明上一轮被中断、哪些工具调用结果未知，并提供两个按钮：
 * 「继续上次任务」和「不用了」。
 *
 * 为什么必须由人确认：进程死亡时可能正有写文件 / git push / 部署之类的调用在飞，
 * 结果未知。自动重放有真实副作用风险，所以这里永远只提示、不自动发起。
 *
 * 不自己扫描会话事件来判断：问宿主（它读持久化日志，冷会话也能读），
 * 浏览器只负责渲染和点击。真正的「继续」也由宿主用 agent.followup() 完成。
 */

window.__ModuleLoader__.load({
  id: 'dsh-llm-network-retry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CHANNEL = '/llm-network-retry';
    const { useCallback, useEffect, useRef, useState } = React;

    /** 统一返回 `{ ok: true, value }` 或 `{ ok: false, message }`，从不抛。 */
    function call(api, endpoint, payload) {
      const rpc = api && api.connection && api.connection.rpc;
      if (!rpc || typeof rpc.call !== 'function') {
        return Promise.resolve({ ok: false, message: '与宿主的连接不可用' });
      }
      return rpc.call(CHANNEL, endpoint, payload === undefined ? {} : payload).then(
        function (result) {
          if (result && result.ok === true) return { ok: true, value: result.value };
          const error = result && result.error;
          return { ok: false, message: (error && error.message) || '请求失败' };
        },
        function (error) {
          return { ok: false, message: (error && error.message) || String(error) };
        },
      );
    }

    // ---------- 启动扫描缓存 ----------
    //
    // 侧边栏每行都要知道「这个会话是不是崩溃过的」，但每行各发一次 RPC 会放大成
    // N 次请求。这里做一份进程内共享缓存：第一个订阅者触发一次拉取，所有行共享结果；
    // 宿主扫描还没结束时返回 done:false，稍后重试，避免把「还没扫完」渲染成「没有」。

    function createScanStore(api) {
      let state = { done: false, sessions: {}, loaded: false };
      const listeners = new Set();
      let inFlight = null;
      let timer = null;

      const emit = () => { for (const fn of listeners) fn(); };

      const fetchOnce = () => {
        if (inFlight) return inFlight;
        inFlight = call(api, 'scan', {}).then(
          (result) => {
            inFlight = null;
            if (!result.ok) return;
            const value = result.value || {};
            state = {
              done: value.done === true,
              sessions: value.sessions || {},
              loaded: true,
            };
            emit();
            // 宿主还在扫：过一会儿再问，而不是当成「没有」。
            if (!state.done) timer = setTimeout(fetchOnce, 1500);
          },
          () => { inFlight = null; },
        );
        return inFlight;
      };

      return {
        subscribe(fn) {
          listeners.add(fn);
          if (!state.loaded && !inFlight) fetchOnce();
          return function () {
            listeners.delete(fn);
            if (listeners.size === 0 && timer) {
              clearTimeout(timer);
              timer = null;
            }
          };
        },
        getSnapshot() { return state; },
        /** 某个会话崩溃过则返回它的恢复摘要，否则 undefined。 */
        forSession(sessionId) {
          if (!sessionId || !state.done) return undefined;
          return state.sessions[sessionId];
        },
        /** 续跑成功后本地抹掉标记，不必等下一次扫描。 */
        clear(sessionId) {
          if (!sessionId || state.sessions[sessionId] === undefined) return;
          const sessions = { ...state.sessions };
          delete sessions[sessionId];
          state = { ...state, sessions };
          emit();
        },
        refresh() {
          state = { ...state, loaded: false };
          return fetchOnce();
        },
      };
    }

    // ---------- 样式（只用主题 token，跟随亮/暗切换）----------

    function styles() {
      return {
        bar: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          margin: '8px 0 0',
          padding: '10px 12px',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-warning, var(--dsw-alias-border-base, #c9a227))',
          background: 'var(--dsw-alias-bg-warning, var(--dsw-alias-bg-secondary, rgba(201,162,39,0.08)))',
          color: 'var(--dsw-alias-text-primary, inherit)',
          fontSize: '13px',
          lineHeight: 1.5,
        },
        body: { flex: '1 1 auto', minWidth: 0 },
        title: { fontWeight: 600, marginBottom: '2px' },
        detail: {
          color: 'var(--dsw-alias-text-secondary, inherit)',
          fontSize: '12px',
          wordBreak: 'break-word',
        },
        actions: { display: 'flex', gap: '8px', flexShrink: 0 },
        primary: {
          padding: '4px 12px',
          borderRadius: '8px',
          border: '1px solid var(--dsw-alias-border-base, transparent)',
          background: 'var(--dsw-alias-bg-accent, #0f766e)',
          color: 'var(--dsw-alias-text-on-accent, #fff)',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
        },
        ghost: {
          padding: '4px 10px',
          borderRadius: '8px',
          border: '1px solid transparent',
          background: 'transparent',
          color: 'var(--dsw-alias-text-secondary, inherit)',
          fontSize: '12px',
          cursor: 'pointer',
        },
        error: {
          marginTop: '4px',
          color: 'var(--dsw-alias-text-danger, #b91c1c)',
          fontSize: '12px',
        },
      };
    }

    // ---------- 组件 ----------

    /**
     * 会话行里的小圆点：该会话上次是崩溃中断的，点开就会自动接着跑。
     * 只做提示，不响应点击——点行本身就是「打开并继续」。
     */
    function InterruptedBadge(props) {
      const store = props.store;
      const sessionId = props.sessionId;
      const locale = props.locale;

      const [state, setState] = useState(store.getSnapshot);
      useEffect(
        function () {
          const sync = function () { setState(store.getSnapshot()); };
          sync();
          return store.subscribe(sync);
        },
        [store],
      );

      const entry = state.done ? state.sessions[sessionId] : undefined;
      if (entry === undefined) return null;

      const tools = Array.isArray(entry.unfinished) ? entry.unfinished : [];
      const tip =
        tools.length === 0
          ? locale.t('badge.tip.noTools', { turn: entry.turn })
          : locale.t('badge.tip.tools', { turn: entry.turn, tools: tools.join('、') });

      return h(
        'span',
        {
          title: tip,
          'aria-label': tip,
          role: 'img',
          style: {
            display: 'inline-block',
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: 'var(--dsw-alias-text-warning, #c9a227)',
            boxShadow: '0 0 0 2px var(--dsw-alias-bg-secondary, transparent)',
            flexShrink: 0,
          },
        },
      );
    }

    function CrashRecoveryBar(props) {
      const api = props.api;
      const sessionId = props.sessionId;
      const locale = props.locale;
      const onContinued = props.onContinued;

      const [state, setState] = useState(null); // null | {recoverable:boolean,...}
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [dismissed, setDismissed] = useState(false);
      const alive = useRef(true);

      useEffect(function () {
        alive.current = true;
        return function () {
          alive.current = false;
        };
      }, []);

      // 会话切换时重新判断（不同会话的恢复状态互不影响）。
      useEffect(
        function () {
          setState(null);
          setError('');
          setBusy(false);
          setDismissed(false);
          if (!sessionId) return;
          call(api, 'inspect', { sessionId: sessionId }).then(function (result) {
            if (!alive.current) return;
            if (result.ok) setState(result.value);
          });
        },
        [api, sessionId],
      );

      const onContinue = useCallback(
        function () {
          if (!sessionId || busy) return;
          setBusy(true);
          setError('');
          call(api, 'continue', { sessionId: sessionId }).then(function (result) {
            if (!alive.current) return;
            setBusy(false);
            if (result.ok) {
              setState({ recoverable: false });
              // 标记立刻消失，不用等下一轮扫描。
              if (onContinued) onContinued(sessionId);
              return;
            }
            setError(result.message);
          });
        },
        [api, busy, sessionId],
      );

      const s = styles();
      if (!sessionId || dismissed) return null;
      if (!state || state.recoverable !== true) return null;

      const turn = typeof state.turn === 'number' ? state.turn : 0;
      const tools = Array.isArray(state.unfinished) ? state.unfinished : [];
      const title = locale.t('resume.title', { turn: turn });
      const detail =
        tools.length === 0
          ? locale.t('resume.detail.noTools')
          : locale.t('resume.detail.tools', { tools: tools.join('、') });

      return h(
        'div',
        { style: s.bar, role: 'status' },
        h(
          'div',
          { style: s.body },
          h('div', { style: s.title }, title),
          h('div', { style: s.detail }, detail),
          error ? h('div', { style: s.error }, error) : null,
        ),
        h(
          'div',
          { style: s.actions },
          h(
            'button',
            {
              type: 'button',
              style: s.primary,
              disabled: busy,
              onClick: onContinue,
            },
            busy ? locale.t('resume.continuing') : locale.t('resume.action'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: s.ghost,
              disabled: busy,
              onClick: function () {
                setDismissed(true);
              },
            },
            locale.t('resume.dismiss'),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        // The RPC channel is reached through the plugin's own connection service,
        // which is what slot props do not reliably carry.
        const api = { connection: ctx.connection };
        // 文案走客户端 locale 服务，跟随界面语言，不硬编码中文。
        ctx.effect(
          () =>
            ctx.locale.register('llm-network-retry', {
              en: {
                'resume.title': 'The previous run was interrupted (turn {turn})',
                'resume.detail.noTools': 'DSH exited before this turn finished. No tool call was left mid-flight.',
                'resume.detail.tools':
                  'DSH exited before this turn finished. These tool calls have unknown outcomes: {tools}. Continue only after checking the real state.',
                'resume.action': 'Continue that task',
                'resume.continuing': 'Continuing…',
                'resume.dismiss': 'Not now',
                'badge.tip.noTools': 'This session was interrupted (turn {turn}). Opening it resumes the task.',
                'badge.tip.tools':
                  'This session was interrupted (turn {turn}). Opening it resumes the task; these tool calls have unknown outcomes: {tools}.',
              },
              zh: {
                'resume.title': '上次运行被中断（第 {turn} 轮）',
                'resume.detail.noTools': 'DSH 在本轮完成前退出。没有工具调用停在中间。',
                'resume.detail.tools':
                  'DSH 在本轮完成前退出。这些工具调用的结果未知：{tools}。请核对真实状态后再继续。',
                'resume.action': '继续上次任务',
                'resume.continuing': '正在继续…',
                'resume.dismiss': '不用了',
                'badge.tip.noTools': '这个会话上次被中断了（第 {turn} 轮）。点开会自动接着跑。',
                'badge.tip.tools': '这个会话上次被中断了（第 {turn} 轮）。点开会自动接着跑；这些工具调用结果未知：{tools}。',
              },
            }),
          'llm-network-retry: locale',
        );

        // `bind` returns a translator; re-read it on every render so the banner
        // follows a live language switch without re-registering the slot.
        const locale = {
          t(key, values) {
            return ctx.locale.bind('llm-network-retry')(key, values);
          },
        };

        // 启动扫描的共享缓存：所有会话行共用一次拉取。
        const scanStore = createScanStore(api);

        // 会话行标记。`sidebar.session.row.leading` 是行标题前原本放状态点的格子，
        // 不遮挡任何现有 UI，也不会和状态点抢位置（有标记时占位、无标记时不渲染）。
        ctx.slots.inject('sidebar.session.row.leading', () =>
          ctx.slots.register(
            {
              name: 'sidebar.session.row.leading',
              id: 'llm-network-retry-interrupted',
              order: 10,
            },
            function InterruptedRowLeading(props) {
              return h(InterruptedBadge, {
                store: scanStore,
                sessionId: props.sessionId,
                locale: locale,
              });
            },
          ),
        );

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'llm-network-retry-resume',
              order: 5,
            },
            function CrashRecoveryDock(props) {
              return h(CrashRecoveryBar, {
                api: api,
                sessionId: props.sessionId,
                locale: locale,
                onContinued: function (id) { scanStore.clear(id); },
              });
            },
          ),
        );
      },
    };
  },
});
