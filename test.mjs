/**
 * Offline checks for the workspace-stats bundle.
 *
 * The point is to exercise the shipped `client.js`, not a copy of it. This file
 * emulates the page: a `window.__ModuleLoader__` that captures the factory, a
 * minimal React, and a `workspaceFiles.list` face backed by a real temporary
 * directory tree. It then mounts the widget, lets its data effect run, and reads
 * the text it renders — so a wrong file count or a wrong byte total fails here
 * rather than in the browser.
 *
 *   node plugins/workspace-stats/test.mjs
 *
 * A green run does not replace looking at the pill in the page; it covers the
 * counting and the module contract, which a syntax check cannot.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(label);
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** Ground truth: every entry below `root`, dot-entries included. */
async function truth(dir = root) {
  const found = { files: 0, bytes: 0, directories: 0 };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.directories += 1;
      const inner = await truth(path);
      found.files += inner.files;
      found.bytes += inner.bytes;
      found.directories += inner.directories;
    } else {
      found.files += 1;
      found.bytes += (await stat(path)).size;
    }
  }
  return found;
}

/** A `workspaceFiles.list` face over the real filesystem. */
function fakeRemote(root) {
  const calls = [];
  const remote = {
    workspaceFiles: {
      async list(sessionId, workspacePath) {
        calls.push(workspacePath);
        const dir = workspacePath === '.' ? root : join(root, ...workspacePath.split('/'));
        const entries = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const child = join(dir, entry.name);
          if (entry.isDirectory()) entries.push({ name: entry.name, type: 'directory' });
          else if (entry.isFile()) entries.push({ name: entry.name, type: 'file', size: (await stat(child)).size });
          else entries.push({ name: entry.name, type: 'other' });
        }
        return { ok: true, value: { path: workspacePath === '.' ? '' : workspacePath, entries, truncated: false } };
      },
    },
  };
  return { remote, calls };
}

/** React stand-in with the hook order the widget uses. */
function createReact() {
  const cells = [];
  const cleanups = [];
  const pending = [];
  let cursor = 0;
  let instance = null;

  const api = {
    createElement(type, props, ...children) {
      return { type, props: props ?? null, children };
    },
    useState(initial) {
      const index = cursor++;
      if (cells.length <= index) cells[index] = initial;
      return [
        cells[index],
        (next) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next;
          instance.rerender();
        },
      ];
    },
    useEffect(fn) {
      pending.push(fn);
    },
    useRef(initial) {
      const index = cursor++;
      if (cells.length <= index) cells[index] = { current: initial };
      return cells[index];
    },
  };

  return {
    api,
    mount(component, props) {
      instance = {
        render() {
          cursor = 0;
          pending.length = 0;
          return component(props);
        },
        rerender() {
          rendered = instance.render();
        },
      };
      let rendered = instance.render();
      for (const fn of pending) {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      return {
        get tree() {
          return rendered;
        },
        rerender() {
          instance.rerender();
        },
        async settle() {
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        unmount() {
          for (const cleanup of cleanups) cleanup();
        },
      };
    },
  };
}

/** Load client.js the way the page does and hand back its plugin object. */
async function loadPlugin() {
  const react = createReact();
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
  globalThis.document = {
    head: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  };
  const source = await readFile(join(here, 'client.js'), 'utf8');
  // eslint-disable-next-line no-new-func -- the file is a browser bundle, not a module.
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  const require = (name) => {
    if (name === 'react') return react.api;
    throw new Error(`unexpected require(${JSON.stringify(name)})`);
  };
  return { spec: captured, plugin: captured.factory(require), react };
}

/** Flatten a rendered element tree to its text. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}

console.log('\n1. module contract');
const { spec, plugin, react } = await loadPlugin();
check('registers through window.__ModuleLoader__.load', spec !== null);
check('factory id equals the package name', spec.id === '@local/dsh-workspace-stats', spec.id);
check('factory returns a plugin object', typeof plugin === 'object' && plugin !== null);
check(
  'declares inject slots/remote/remote.workspaceFiles',
  Array.isArray(plugin.inject) &&
    plugin.inject.includes('slots') &&
    plugin.inject.includes('remote') &&
    plugin.inject.includes('remote.workspaceFiles'),
  JSON.stringify(plugin.inject),
);
check('exposes apply()', typeof plugin.apply === 'function');

console.log('\n2. slot registration');
let registration = null;
const ctx = {
  slots: {
    inject(slot, callback) {
      check('injects into conversation.composer.dock', slot === 'conversation.composer.dock', slot);
      callback();
    },
    register(options, component) {
      registration = { options, component };
      return () => {};
    },
  },
  remote: null,
};
plugin.apply(ctx);
check('registers a component', registration !== null && typeof registration.component === 'function');
check('options name the slot', registration.options.name === 'conversation.composer.dock');
check('options carry a stable id', registration.options.id === 'workspace-stats', registration.options.id);

console.log('\n3. hidden entries are counted');
const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-stats-'));
const layout = [
  ['README.md', 1000],
  ['.gitignore', 21],
  ['.env', 4],
  ['src/index.js', 2000],
  ['src/deep/nested.txt', 37],
  ['.github/workflows/ci.yml', 512],
  ['.cache/tmp/one.bin', 9],
  ['.cache/tmp/two.bin', 11],
  ['node_modules/pkg/package.json', 64],
];
for (const [path, length] of layout) {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'x'.repeat(length));
}
const expected = await truth();
const { remote, calls } = fakeRemote(root);
ctx.remote = remote;
const view = react.mount(registration.component, { sessionId: 'session-test' });
const loadingText = textOf(view.tree);
await view.settle();
view.rerender();
const settledText = textOf(view.tree);

console.log(`  ground truth: ${expected.files} files, ${expected.bytes} bytes, ${expected.directories} subdirectories`);
check('shows a loading state first', loadingText.includes('正在统计'), loadingText);
check('lists the workspace root', calls.includes('.'), JSON.stringify(calls));
check('descends into every subdirectory', calls.length === expected.directories + 1, `${calls.length} listings`);
check('descends into hidden directories', calls.includes('.cache') && calls.includes('.cache/tmp'), JSON.stringify(calls));
check('counts every file, dot-entries included', settledText.includes(`${expected.files} 个文件`), settledText);
check('sums every byte', settledText.includes(formatBytesForTest(expected.bytes)), settledText);
check('mentions no failure', !settledText.includes('失败'), settledText);
view.unmount();

console.log('\n4. an unlistable root degrades instead of crashing');
const failing = {
  workspaceFiles: {
    async list() {
      return { ok: false, error: { code: 'workspace-file/not-found', message: 'no entry at "."' } };
    },
  },
};
ctx.remote = failing;
const errorView = react.mount(registration.component, { sessionId: 'session-test' });
await errorView.settle();
check('renders without throwing', errorView.tree !== null);
check('reports zero rather than failing', textOf(errorView.tree).includes('0 个文件'), textOf(errorView.tree));
errorView.unmount();

console.log('\n5. no session is a quiet state');
ctx.remote = remote;
const emptyView = react.mount(registration.component, {});
await emptyView.settle();
check('renders the unknown state', textOf(emptyView.tree).includes('工作区未知'), textOf(emptyView.tree));
emptyView.unmount();

await rm(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}

/** The same human-readable rule the widget uses, restated for expectations. */
function formatBytesForTest(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`;
}
