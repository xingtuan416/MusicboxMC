/**
 * The companion resource pack.
 *
 * It ships inside the application rather than behind a download link, so saving it is one
 * dialog and no network. It is offered in two places: a button in the export step, which is
 * always there, and a one-time nudge the first time a full-range schematic is exported.
 *
 * The wording carries the point of the feature. The pack is **not required**: the five
 * instruments the full range uses are all vanilla, so the schematic plays without it and
 * only the timbre differs between octave bands. The interface used to imply otherwise, and
 * that is what this exists to correct.
 */

/** Remembers that the nudge has been shown, so it is shown once. */
const PROMPTED_KEY = 'musicboxmc.resourcePackPrompted';

function wasPrompted() {
  try {
    return localStorage.getItem(PROMPTED_KEY) === '1';
  } catch {
    // Storage unavailable or blocked. Stay quiet rather than nag on every export.
    return true;
  }
}

function markPrompted() {
  try {
    localStorage.setItem(PROMPTED_KEY, '1');
  } catch {
    // Ignored; the worst case is one extra nudge.
  }
}

/**
 * Ask the main process to write a copy of the bundled pack where the user chooses.
 *
 * @returns the chosen path, or null when the user cancelled.
 */
async function savePack() {
  return window.musicbox.saveResourcePack();
}

/** The one-time nudge, with the save action inside it. */
function showPackNudge() {
  const backdrop = document.createElement('div');
  // `open` is what the stylesheet uses to display the backdrop; without it the nudge is
  // in the DOM and invisible.
  backdrop.className = 'modal-backdrop open';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', '配套资源包');

  const dialog = document.createElement('div');
  dialog.className = 'settings-dialog';

  const heading = document.createElement('h3');
  heading.style.cssText = 'font-size:20px;font-weight:800;margin:0;';
  heading.textContent = '全音域：可以装一个配套资源包';

  const body = document.createElement('p');
  body.style.cssText = 'font-size:13.5px;color:var(--ink-secondary);margin:0;line-height:1.7;';
  body.textContent =
    '这次生成覆盖了 F#1–F#7，用到 bass、guitar、harp、flute、bell 五个原版音色。' +
    '不装资源包也能完整演奏——五个都是原版乐器——只是五个八度段听起来不是同一种琴。' +
    '配套资源包把它们换成钢琴采样，约 50 KB，就在应用里，之后也能在导出这一步取。';

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;';

  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'btn-glass';
  later.textContent = '以后再说';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-obsidian';
  save.textContent = '保存资源包';

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  later.addEventListener('click', close);
  save.addEventListener('click', () => {
    close();
    void savePack();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  actions.append(later, save);
  dialog.append(heading, body, actions);
  backdrop.append(dialog);
  document.body.append(backdrop);
  save.focus();
}

/**
 * Called after an export that actually wrote a file.
 *
 * Gated on the full range as well as on being the first time: the narrow palette uses the
 * harp slot alone, so the pack would change nothing and the nudge would be noise.
 */
function maybePromptForPack(extendedRange) {
  if (!extendedRange || wasPrompted()) return;
  markPrompted();
  showPackNudge();
}

export { savePack, maybePromptForPack, showPackNudge };
