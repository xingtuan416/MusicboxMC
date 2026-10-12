/**
 * MIDI note naming.
 *
 * The covered range is no longer a constant: it depends on whether the extended
 * palette is on, so anything that names a pitch has to ask the result rather than
 * hardcode "F#1-F#7".
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number → scientific pitch name, e.g. 30 → F#1. */
function pitchName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** "F#1–F#7" for a covered range; a neutral label when the result carries none. */
function pitchRangeLabel(range) {
  if (!range) return '已选音域';
  return `${pitchName(range.low)}–${pitchName(range.high)}`;
}

export { pitchName, pitchRangeLabel };
