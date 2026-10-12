import { $ } from './state.js';

/**
 * What the range switch actually buys, in the user's words.
 *
 * All five instruments the wide palette uses are vanilla, so a generated schematic
 * plays with no resource pack; the pack only makes those five octave bands sound like
 * one piano. Saying otherwise made an optional download look mandatory.
 */
const PITCH_HINT = {
  full:
    '使用 bass、guitar、harp、flute、bell 五个原版音色拼出 F#1–F#7（MIDI 30-102）。' +
    '这五个都是原版乐器，不装资源包也能完整演奏，只是五个八度段音色不同；' +
    '配套资源包（可选，见 Release）可把它们统一成钢琴音色。仍超出此范围的音符按下方策略处理。',
  piano:
    '只用 harp 单一音色，音域 F#3–F#5（MIDI 54-78），完全不需要资源包。' +
    '仍超出此范围的音符按下方策略处理。',
};

/** Keep the range hint in step with the switch. */
function syncPitchRangeHint() {
  const hint = $('pitchRangeHint');
  if (hint) hint.textContent = $('extendedRange').checked ? PITCH_HINT.full : PITCH_HINT.piano;
}

function collectOptions() {
  const excluded = [];
  for (const cb of document.querySelectorAll('#trackList input[type=checkbox]')) {
    if (!cb.checked) excluded.push(Number(cb.dataset.index));
  }
  return {
    baseTps: Number($('baseTps').value) || 20,
    dMax: Number($('dMax').value) || 14,
    outOfRange: $('outOfRange').value,
    extendedRange: $('extendedRange').checked,
    mergeSameInstrument: $('mergeSameInstrument').checked,
    forceMergeSameInstrument: $('mergeSameInstrument').checked && $('forceMergeSameInstrument').checked,
    commandPlayback: $('commandPlayback').checked,
    commandChainBudget: Number($('commandChainBudget').value),
    excludeTracks: excluded,
    author: $('author').value || 'MusicboxMC',
  };
}

export { collectOptions, syncPitchRangeHint };
