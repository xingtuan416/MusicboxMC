import { $ } from './state.js';

const LOG_LINE_LIMIT = 400;

const logLines = [];
function log(line) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logLines.push(`[${ts}] ${line}`);
  if (logLines.length > LOG_LINE_LIMIT) logLines.shift();
  $('log').textContent = logLines.join('\n');
}

export { log };
