import { $ } from './state.js';

/**
 * The banner is a single element shared by several messages, so assigning to it
 * directly makes them overwrite each other (which once swallowed a must-show
 * warning about notes outside the pitch range). Accumulate instead, and let the
 * most severe level decide the colour.
 */
const BANNER_LEVEL = { ok: 0, warn: 1, err: 2 };
const bannerState = { level: null, lines: [] };

function banner(kind, text) {
  if (bannerState.level === null) {
    bannerState.level = kind;
    bannerState.lines = [];
  } else if (BANNER_LEVEL[kind] > BANNER_LEVEL[bannerState.level]) {
    bannerState.level = kind;
  }
  bannerState.lines.push(text);

  const el = $('banner');
  el.className = `banner ${bannerState.level}`;
  el.textContent = bannerState.lines.join('\n');
}

function resetBanner() {
  bannerState.level = null;
  bannerState.lines = [];
}

function hideBanner() {
  resetBanner();
  $('banner').className = 'banner hidden';
}

export { banner, resetBanner, hideBanner };
