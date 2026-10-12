import { $, api } from './state.js';
import { create } from './dom.js';
import { log } from './log.js';

/**
 * The companion resource pack.
 *
 * It ships inside the application rather than behind a download link, and the
 * interface offers it in two places: a button that is always there, and a one-time
 * nudge when a full-range schematic is exported for the first time.
 *
 * The wording matters here. The pack is not required - the five instruments it
 * replaces are vanilla, so the schematic plays without it - it only makes those five
 * octave bands sound like one piano. Calling it required is what this feature exists
 * to correct.
 */

/** Remembers that the nudge has been shown, so it appears once. */
const PROMPTED_KEY = 'musicboxmc.resourcePackPrompted';

function wasPrompted() {
  try {
    return localStorage.getItem(PROMPTED_KEY) === '1';
  } catch {
    // No storage, or it is blocked: stay quiet rather than nag on every export.
    return true;
  }
}

function markPrompted() {
  try {
    localStorage.setItem(PROMPTED_KEY, '1');
  } catch {
    // Ignored. The worst case is one extra nudge.
  }
}

/** Ask the main process for a copy of the bundled pack. */
async function saveResourcePack() {
  const target = await api.saveResourcePack();
  if (target) {
    log(`资源包已保存到 ${target}`);
    log('把它放进 .minecraft/resourcepacks/，然后在游戏里启用。');
  }
  return target;
}

/** The one-time nudge, with the save action inside it. */
function showPackPrompt() {
  const backdrop = create('div', 'modal-backdrop');
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const card = create('div', 'modal-card');
  card.append(
    create('h3', null, '全音域拓展：建议安装配套资源包'),
    create(
      'p',
      null,
      '这次生成覆盖了 F#1–F#7，用的是 bass、guitar、harp、flute、bell 五个原版音色。' +
        '五个都是原版乐器，不装资源包也能完整演奏，只是五个八度段的音色不同。',
    ),
    create(
      'p',
      null,
      '配套资源包把这五个音色换成钢琴采样，让整个音域听起来是同一架钢琴。' +
        '它就在应用里，约 50 KB，随时可以在这个开关下面取。',
    ),
  );

  const actions = create('div', 'modal-actions');
  const later = create('button', 'btn secondary', '稍后');
  later.addEventListener('click', close);
  const save = create('button', 'btn primary', '保存资源包');
  save.addEventListener('click', async () => {
    close();
    await saveResourcePack();
  });
  actions.append(later, save);
  card.append(actions);
  backdrop.append(card);

  // Clicking the backdrop dismisses; clicking the card itself must not.
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.append(backdrop);
}

/** Called after a successful export: shows the nudge once, and only for the full range. */
function maybePromptForPack() {
  if (!$('extendedRange').checked || wasPrompted()) return;
  markPrompted();
  showPackPrompt();
}

export { saveResourcePack, maybePromptForPack, showPackPrompt };
