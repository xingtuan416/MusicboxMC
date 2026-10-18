/**
 * Display names and ranges for the sixteen note-block instruments.
 *
 * The renderer cannot import `src/core`, so this small table mirrors the data the
 * engine uses. It is only for labels and warning text; the engine remains the source
 * of truth for placement.
 */

const INSTRUMENT_NAMES = {
  harp: '竖琴',
  bass: '贝斯',
  basedrum: '底鼓',
  snare: '军鼓',
  hat: '踩镲',
  guitar: '吉他',
  flute: '长笛',
  bell: '铃铛',
  chime: '钟琴',
  xylophone: '木琴',
  iron_xylophone: '铁木琴',
  cow_bell: '牛铃',
  didgeridoo: '迪吉里杜管',
  bit: '比特',
  banjo: '班卓',
  pling: '电钢琴',
};

/** [low, high] MIDI range; null for the fixed-pitch drums. */
const INSTRUMENT_RANGES = {
  harp: [54, 78],
  bass: [30, 54],
  basedrum: null,
  snare: null,
  hat: null,
  guitar: [42, 66],
  flute: [66, 90],
  bell: [78, 102],
  chime: [78, 102],
  xylophone: [78, 102],
  iron_xylophone: [54, 78],
  cow_bell: [66, 90],
  didgeridoo: [30, 54],
  bit: [54, 78],
  banjo: [54, 78],
  pling: [54, 78],
};

function instrumentName(id) {
  if (id === 'piano') return '钢琴扩展';
  if (id === 'drums') return '打击乐';
  return INSTRUMENT_NAMES[id] || id;
}

function instrumentRange(id) {
  return INSTRUMENT_RANGES[id] ?? null;
}

export { INSTRUMENT_NAMES, INSTRUMENT_RANGES, instrumentName, instrumentRange };
