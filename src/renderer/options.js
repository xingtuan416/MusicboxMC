import { $ } from './state.js';

function collectOptions() {
  const excluded = [];
  for (const cb of document.querySelectorAll('#trackList input[type=checkbox]')) {
    if (!cb.checked) excluded.push(Number(cb.dataset.index));
  }
  return {
    baseTps: Number($('baseTps').value) || 20,
    dMax: Number($('dMax').value) || 14,
    outOfRange: $('outOfRange').value,
    mergeSameInstrument: $('mergeSameInstrument').checked,
    forceMergeSameInstrument: $('mergeSameInstrument').checked && $('forceMergeSameInstrument').checked,
    commandPlayback: $('commandPlayback').checked,
    commandChainBudget: Number($('commandChainBudget').value),
    excludeTracks: excluded,
    author: $('author').value || 'MusicboxMC',
  };
}

export { collectOptions };
