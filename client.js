/**
 * Client half of `@local/dsh-workspace-stats`.
 *
 * It renders one pill under the composer showing how many files the current
 * Session's workspace holds and how many bytes they add up to. Hidden entries
 * (names starting with `.`) are counted like any other entry, because the
 * workspace listing is an ordinary directory read: no ignore list, no glob.
 *
 * Browser module format: the Host serves this file, and the page's
 * `window.__ModuleLoader__` calls the factory. The factory's `id` MUST equal
 * the package name, and `require` resolves only modules the page already has
 * (React among them) — never a Harness Client package.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-stats',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Listings are paged by the Host; a cycle can only come from directory links. */
    const MAX_DEPTH = 64;
    /** Stop after this many directories so a symlink farm cannot hang the page. */
    const MAX_DIRECTORIES = 20000;

    /** Theme tokens only: a renamed token degrades the look, it never breaks rendering. */
    const CSS = [
      '.dsh-workspace-stats-root{display:flex;align-items:center;justify-content:center;gap:12px;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));}',
      '.dsh-workspace-stats-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;',
      'max-width:100%;padding:1px 8px;border:none;border-radius:999px;background:0 0;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;',
      'white-space:nowrap;cursor:pointer;}',
      '.dsh-workspace-stats-pill:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary);}',
      '.dsh-workspace-stats-pill[disabled]{cursor:default;background:0 0;',
      'color:var(--dsw-alias-label-tertiary);}',
      '.dsh-workspace-stats-pill svg{flex:none;width:14px;height:14px;}',
      '.dsh-workspace-stats-label{min-width:0;overflow:hidden;text-overflow:ellipsis;}',
      '.dsh-workspace-stats-sep{flex:none;width:1px;height:12px;background:var(--dsw-alias-separator-primary);}',
      '.dsh-workspace-stats-note{color:var(--dsw-alias-label-tertiary);}',
    ].join('');

    const STYLE_TAG = '@local/dsh-workspace-stats/widget.css';

    /** Mount the widget stylesheet once; unmounting removes it again. */
    function ensureStyleTag() {
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG) + ']') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-workspace-stats';
      tag.dataset.pluginCss = STYLE_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function removeStyleTag() {
      const tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG) + ']');
      if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
    }

    /** Join a workspace path with a child name; the workspace root itself is `'.'`. */
    function childPath(parent, name) {
      return parent === '.' ? name : parent + '/' + name;
    }

    /** `1234` → `1.2 KB`; one decimal place from KiB on, exact bytes below. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return bytes + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return (value >= 100 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[unit];
    }

    /** Thousands separators, so a six-digit file count stays readable. */
    function formatCount(count) {
      return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function FolderIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' }),
      );
    }

    function RefreshIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }),
        h('path', { d: 'M20 4.5V10h-5.5' }),
      );
    }

    /**
     * Walk one Session's workspace and total its files.
     *
     * `list` returns each directory's direct children with `type` and, for
     * regular files, `size`. Only directories are descended into; every other
     * entry counts as one file, and a file without a reported size contributes
     * zero bytes and sets `partial`, so the widget never claims a total it does
     * not have. Absent and unlistable directories are skipped, not fatal.
     *
     * @param remote - the Client Remote face carrying `workspaceFiles.list`.
     * @param sessionId - Session whose workspace is measured.
     * @param signal - aborts the walk when the Session changes or the view unmounts.
     * @returns totals plus the truncation flags worth showing the user.
     */
    async function measureWorkspace(remote, sessionId, signal) {
      const result = {
        files: 0,
        bytes: 0,
        directories: 1,
        partial: false,
        truncated: false,
        unreadable: 0,
      };
      const queue = [{ path: '.', depth: 0 }];
      const visited = new Set(['.']);

      while (queue.length > 0) {
        if (signal.aborted) throw abortError(signal);
        const current = queue.shift();
        const listed = await remote.workspaceFiles.list(sessionId, current.path, signal);
        if (listed.ok !== true) {
          result.unreadable += 1;
          continue;
        }
        const listing = listed.value;
        if (listing.truncated) result.truncated = true;
        for (const entry of listing.entries) {
          if (entry.name === '.' || entry.name === '..') continue;
          const path = childPath(listing.path === '' ? '.' : listing.path, entry.name);
          if (entry.type === 'directory') {
            if (current.depth + 1 > MAX_DEPTH || visited.size >= MAX_DIRECTORIES) {
              result.truncated = true;
              continue;
            }
            if (visited.has(path)) continue;
            visited.add(path);
            result.directories += 1;
            queue.push({ path, depth: current.depth + 1 });
            continue;
          }
          result.files += 1;
          if (typeof entry.size === 'number') result.bytes += entry.size;
          else result.partial = true;
        }
      }
      return result;
    }

    function abortError(signal) {
      return signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }

    /**
     * The widget itself. Slot props carry `sessionId`; the composer only mounts
     * this dock inside a Session, so the id is always present here.
     */
    function WorkspaceStats({ sessionId }) {
      const [state, setState] = React.useState({ phase: 'loading', result: null, error: null });
      const [attempt, setAttempt] = React.useState(0);

      React.useEffect(() => {
        ensureStyleTag();
        return removeStyleTag;
      }, []);

      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null || sessionId === '') {
          setState({ phase: 'ready', result: null, error: null });
          return undefined;
        }
        const controller = new AbortController();
        setState({ phase: 'loading', result: null, error: null });
        measureWorkspace(ctx.remote, sessionId, controller.signal).then(
          (result) => {
            if (!controller.signal.aborted) setState({ phase: 'ready', result, error: null });
          },
          (error) => {
            if (controller.signal.aborted) return;
            setState({ phase: 'error', result: null, error: error });
          },
        );
        return () => controller.abort();
      }, [sessionId, attempt]);

      const result = state.result;
      const loading = state.phase === 'loading';
      let text;
      if (loading) text = '正在统计工作区…';
      else if (state.phase === 'error') text = '工作区统计失败';
      else if (result === null) text = '工作区未知';
      else text = formatCount(result.files) + ' 个文件 · ' + formatBytes(result.bytes);

      const title =
        state.phase === 'error'
          ? String(state.error && state.error.message ? state.error.message : state.error)
          : loading
            ? '正在统计'
            : result === null
              ? '当前会话没有工作区'
              : formatCount(result.files) + ' files · ' + formatBytes(result.bytes) +
                (result.partial ? ' · 部分文件未报告大小' : '') +
                (result.truncated ? ' · 已达扫描上限' : '') +
                (result.unreadable > 0 ? ' · ' + result.unreadable + ' 个目录不可读' : '');

      return h(
        'div',
        { className: 'dsh-workspace-stats-root', 'data-dsh-workspace-stats': '' },
        h(
          'span',
          { className: 'dsh-workspace-stats-pill', title },
          h(FolderIcon),
          h(
            'span',
            { className: 'dsh-workspace-stats-label', 'aria-live': 'polite' },
            text,
            result !== null && (result.partial || result.truncated)
              ? h('span', { className: 'dsh-workspace-stats-note' }, ' *')
              : null,
          ),
        ),
        h('span', { className: 'dsh-workspace-stats-sep', 'aria-hidden': true }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-workspace-stats-pill',
            title: '重新统计',
            'aria-label': '重新统计工作区',
            disabled: loading,
            onClick: () => setAttempt((value) => value + 1),
          },
          h(RefreshIcon),
        ),
      );
    }

    // The factory runs before any context exists: no work happens here, only
    // registration. `ctx` below is this plugin's own restricted context, and it
    // carries only the services listed in `inject`.
    let ctx = null;

    return {
      name: '@local/dsh-workspace-stats',
      inject: ['slots', 'remote', 'remote.workspaceFiles'],
      apply(pluginCtx) {
        ctx = pluginCtx;
        pluginCtx.slots.inject('conversation.composer.dock', () =>
          pluginCtx.slots.register(
            { name: 'conversation.composer.dock', id: 'workspace-stats', order: 20 },
            WorkspaceStats,
          ),
        );
      },
    };
  },
});
