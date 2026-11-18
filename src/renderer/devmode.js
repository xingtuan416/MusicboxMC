/**
 * Developer mode.
 *
 * An opt-in diagnostics drawer. It shows the raw data the interface consumes - the current
 * state, what smart routing measured, the last generation result - plus every IPC call with
 * its duration, so a problem can be reproduced and inspected without reading the code.
 *
 * It never changes what the generator does: every action here calls the same functions the
 * normal flow calls. Off by default, and the choice is remembered per profile.
 */

const STORAGE_KEY = 'musicboxmc.dev';
const MAX_LOGS = 400;

let api = null;
let enabled = false;
let open = false;
let activeTab = 'state';
let versions = null;
let snapshotProvider = () => ({});
let actions = {};
const logs = [];

const byId = (id) => document.getElementById(id);

function storedEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // A profile without storage still gets the drawer for this session.
  }
}

/** Append one entry; the log tab re-renders only when it is the visible one. */
export function devLog(kind, detail) {
  logs.push({ at: new Date().toISOString().slice(11, 23), kind, detail });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  if (enabled && open && activeTab === 'log') render();
}

export function registerDev(options) {
  snapshotProvider = options.snapshot ?? (() => ({}));
  actions = options.actions ?? {};
}

/**
 * Wrap the preload API so every call lands in the log with its duration.
 *
 * Failures are logged and rethrown unchanged: the interface keeps its own error handling.
 */
export function wrapApi(source) {
  const wrapped = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'function' || name === 'onLog' || name === 'pathForFile') {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (...args) => {
      const start = performance.now();
      try {
        const result = await value(...args);
        devLog('ipc', { call: name, ms: Math.round(performance.now() - start), args: args.map(summarize) });
        return result;
      } catch (error) {
        devLog('error', {
          call: name,
          ms: Math.round(performance.now() - start),
          args: args.map(summarize),
          message: error?.message || String(error),
        });
        throw error;
      }
    };
  }
  return wrapped;
}

function summarize(value) {
  if (typeof value === 'string') return value.length > 180 ? `${value.slice(0, 177)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= 400) return JSON.parse(text);
    return `${text.slice(0, 397)}…`;
  } catch {
    return String(value);
  }
}

function logText() {
  if (logs.length === 0) {
    return '还没有记录。切换步骤、分析文件或生成一次，就会出现在这里。';
  }
  return logs
    .map((entry) => `${entry.at}  ${entry.kind.padEnd(6)}  ${JSON.stringify(entry.detail)}`)
    .join('\n');
}

function render() {
  const output = byId('devOutput');
  if (!output) return;
  const snapshot = snapshotProvider() ?? {};
  let payload;
  if (activeTab === 'state') {
    const { result, ...rest } = snapshot;
    void result;
    payload = { versions, ...rest };
  } else if (activeTab === 'smart') {
    payload = {
      lead: snapshot.state?.lead,
      smart: snapshot.state?.smart,
      tracks: snapshot.tracks,
      lastResult: snapshot.result?.smartSelection ?? null,
    };
  } else if (activeTab === 'result') {
    payload = snapshot.result ?? {
      result: null,
      hint: '还没有结果：在第 6 步跑一次检查，或点下面的「跑检查」。',
    };
  } else {
    payload = logText();
  }
  output.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const status = byId('devStatus');
  if (status) status.textContent = `${logs.length} 条日志`;
}

function syncTabs() {
  for (const tab of document.querySelectorAll('[data-dev-tab]')) {
    tab.classList.toggle('active', tab.dataset.devTab === activeTab);
  }
}

let flashTimer = null;
function flash(text) {
  const status = byId('devStatus');
  if (!status) return;
  status.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    status.textContent = `${logs.length} 条日志`;
  }, 2600);
}

async function refresh() {
  try {
    versions = await api.versions();
  } catch (error) {
    versions = { error: error?.message || String(error) };
  }
  render();
}

async function copyCurrent() {
  const text = byId('devOutput')?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    flash('已复制当前视图');
  } catch {
    flash('复制失败：剪贴板被拒绝');
  }
}

async function saveReport() {
  const snapshot = snapshotProvider() ?? {};
  const report = { generatedAt: new Date().toISOString(), versions, snapshot, logs };
  try {
    const path = await api.saveReport(JSON.stringify(report, null, 2), 'musicboxmc-diagnostics.json');
    flash(path ? `已保存：${path}` : '已取消保存');
  } catch (error) {
    flash(`保存失败：${error?.message || error}`);
  }
}

async function runAction(name) {
  const action = actions[name];
  if (!action) return flash('当前没有可执行的操作');
  flash('执行中…');
  try {
    await action();
  } catch (error) {
    devLog('error', { action: name, message: error?.message || String(error) });
    flash(`失败：${error?.message || error}`);
    return;
  }
  flash('完成');
  render();
}

export function setDevOpen(next) {
  open = next;
  const dock = byId('devDock');
  if (dock) dock.hidden = !next;
  const pill = byId('devToggle');
  if (pill) pill.hidden = !enabled || next;
  if (next && versions === null) void refresh();
  else if (next) render();
}

/**
 * Turn the mode on or off.
 *
 * The panel opens when the user switches it on, but not when the profile merely remembers
 * it: a remembered mode should not cover the window on every launch.
 */
export function setDevMode(on, options = {}) {
  enabled = on;
  persist();
  // CSS shows the dev-only readouts from this class, so the switch is one place.
  document.body.classList.toggle('dev-on', on);
  const pill = byId('devToggle');
  if (pill) pill.hidden = !on || open;
  const button = byId('btnDevMode');
  if (button) {
    button.textContent = on ? '已开启' : '关闭';
    button.classList.toggle('active', on);
  }
  if (!on) setDevOpen(false);
  else if (options.openPanel) setDevOpen(true);
  else if (open) render();
  devLog('mode', { enabled: on });
  syncTabs();
  // The step-4 readout is dev-only; it needs to measure as soon as the mode flips.
  window.dispatchEvent(new CustomEvent('devmode:changed', { detail: { enabled: on } }));
}

/** Re-render the panel after new data arrived while it is open. */
export function refreshDev() {
  if (enabled && open) render();
}

export function isDevMode() {
  return enabled;
}

export function initDevMode(bridge) {
  api = bridge;
  for (const tab of document.querySelectorAll('[data-dev-tab]')) {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.devTab;
      syncTabs();
      render();
    });
  }
  byId('devToggle')?.addEventListener('click', () => setDevOpen(!open));
  byId('btnDevClose')?.addEventListener('click', () => setDevOpen(false));
  byId('btnDevRefresh')?.addEventListener('click', () => void refresh());
  byId('btnDevCopy')?.addEventListener('click', () => void copyCurrent());
  byId('btnDevSave')?.addEventListener('click', () => void saveReport());
  byId('btnDevPlan')?.addEventListener('click', () => void runAction('remeasure'));
  byId('btnDevCheck')?.addEventListener('click', () => void runAction('check'));
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key?.toLowerCase() === 'd') {
      event.preventDefault();
      setDevMode(!enabled, { openPanel: true });
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setDevOpen(false);
    }
  });
  setDevMode(storedEnabled());
}
