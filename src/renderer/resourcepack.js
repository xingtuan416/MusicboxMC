/**
 * The companion resource pack.
 *
 * It ships inside the application rather than behind a download link, so saving it is one
 * dialog and no network. It is offered in two places: a button in the export step, which is
 * always there, and a one-time nudge the first time an extended-mode schematic is exported.
 *
 * The wording has to hold two facts at once, and the earlier version only held the first.
 *
 * The pack is not technically required: the five base notes extended mode uses are all
 * vanilla, so a schematic plays without it. But a melody that crosses an octave boundary
 * changes instrument - bass, then guitar, then harp, then flute, then bell - so what comes
 * out is not one instrument playing a piece. For an extended-mode export that makes the pack
 * necessary in practice, and saying only "you can play without it" was misleading in the
 * other direction. Both sentences belong there.
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
  heading.textContent = '扩展竖琴音域：建议现在就装上配套资源包';

  const body = document.createElement('p');
  body.style.cssText = 'font-size:13.5px;color:var(--ink-secondary);margin:0;line-height:1.7;';
  body.textContent =
    '这次生成用了扩展竖琴音域，钢琴部分覆盖 F#1–F#7。原版音符盒在这个音域里只有五种基底音色：' +
    'bass、guitar、harp、flute、bell。' +
    '不装资源包，投影照样能完整演奏，但一条旋律只要跨过八度边界，音色就会换成另一件乐器，' +
    '听起来不像同一架琴在弹。' +
    '配套资源包把这五段统一成钢琴采样，约 50 KB，就在应用里，' +
    '之后也可以在导出这一步随时取。';

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
 * Gated on extended mode as well as on being the first time. Native mode plays each
 * instrument's own timbre; installing the pack there would also replace native bass,
 * guitar, flute and bell, so the nudge would be wrong.
 */
function maybePromptForPack(extendedMode) {
  if (!extendedMode || wasPrompted()) return;
  markPrompted();
  showPackNudge();
}

export { savePack, maybePromptForPack, showPackNudge };
