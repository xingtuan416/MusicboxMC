import { instrumentName, instrumentRange } from './instruments.js';
import { pitchName, pitchRangeLabel } from './pitch.js';

/**
 * Warning text, severity and location, without any DOM.
 *
 * These were part of the previous renderer's `warnings.js`, which also built its own
 * elements and imported four modules the current interface does not load. The text and the
 * lookups are the valuable part - they say what each warning means in Chinese and where it
 * is - so they live here, dependency-free, and the interface renders them with its own
 * components. Nothing about the wording or the severity mapping changed.
 */

const WARNING_DISPLAY_LIMIT = 500;

const WARN_TEXT = {
  COMMAND_PLAYBACK_REQUIREMENTS: (w) =>
    `命令播放：${w.chainLength} 个链步骤，预算 ${w.budget}。需要启用命令方块、保留方块实体 NBT，并加载整个结构；世界 maxCommandChainLength 必须大于链步骤数。`,
  COMMAND_SOUND_PRESSURE: (w) =>
    `峰值同刻 ${w.peakNotes} 个声音：命令不会排队或丢音，但客户端声音池可能不足，无法保证每个声音都能听到。`,
  COMMAND_STRUCTURE_SIZE: (w) =>
    `命令播放器含 ${w.commandBlocks} 个命令方块，超过安全参考值 ${w.limit}：粘贴与加载会明显变慢，` +
    `命令链每刻的遍历步数也随之增加。建议先排除不必要的音轨或缩短曲目再生成。`,
  POLYPHONY_EXCEEDED: (w) =>
    `tick ${w.tick}：量化音群 ${w.n} 个音，超过单列容量 ${w.limit}，溢出音符另行处理`,
  FORCE_MERGE_LEAD_IN: (w) =>
    `强制合并：全曲统一启动等待 ${w.ticks} 游戏刻，峰值 ${w.peakNotes} 音；曲内相对时序不变`,
  FANOUT_EXPANDED: (w) =>
    `tick ${w.tick}：${w.n} 个音使用 ${w.stages} 级续电分支，单级两侧容量 ${w.limit}；仍为同一主线且同刻发声`,
  STARTUP_LEAD_IN: (w) =>
    `全曲统一延后 ${w.ticks} 游戏刻（${(w.ticks / 20).toFixed(1)} 秒）：红石刻 0 上的音` +
    `也需要一个中继器延迟才能驱动。曲内相对时序不变，不需要处理。`,
  OUT_OF_RANGE: (w, ctx) =>
    `${ctx.label(w.trackIndex)} · ${ctx.at(w.tick)} · MIDI ${w.midi}（${pitchName(w.midi)}）` +
    `超出${rangeTextFor(w, ctx)}，处理方式：` +
    `${OUT_OF_RANGE_ACTION_TEXT[w.action] || w.action}`,
  TIMING_ADJUSTED: (w, ctx) =>
    `${ctx.label(w.trackIndex)} · z${w.z} 行 · ${ctx.at(w.tick)} 的音实际在 ` +
    `${ctx.at(w.actual)} 触发，偏移 ${w.actual - w.tick > 0 ? '+' : ''}${w.actual - w.tick} 游戏刻`,
  TRACK_SPLIT: (w) => `tick ${w.tick}：${w.notes} 个音密集放不下，已自动拆到新音轨`,
  SPATIAL_DRIFT: (w) => `tick ${w.tick}：该处空间偏差 ${w.drift} 格，超出多轨对齐容差`,
  INSTRUMENT_UNKNOWN: (w, ctx) =>
    `${ctx.label(w.trackIndex)} 没能从 GM 音色或轨道名识别出乐器，按竖琴处理。` +
    `需要别的音色时，把轨道名改成乐器名即可。`,
  INSTRUMENT_SUBSTITUTED: (w, ctx) =>
    `${ctx.label(w.trackIndex)} 原生是${instrumentName(w.native)}；扩展竖琴音域占用了这个音色，` +
    `改用${instrumentName(w.effective)}。`,
  INSTRUMENT_OCTAVE_SHIFT: (w, ctx) =>
    `${ctx.label(w.trackIndex)} 为放进${instrumentName(w.instrument)}的两个八度，` +
    `整轨${w.octaves > 0 ? '升' : '降'} ${Math.abs(w.octaves)} 个八度（${w.notes} 个音）。`,
  INSTRUMENT_RANGE_OVERFLOW: (w, ctx) =>
    `${ctx.label(w.trackIndex)} 跨度 ${w.span} 个半音，超过${instrumentName(w.instrument)}的 24 个半音；` +
    `${w.outside} 个音会单独移调。`,
  DRUM_NOTES_DROPPED: (w, ctx) =>
    `${ctx.label(w.trackIndex)} 有 ${w.count} 个打击乐音符无法对应到底鼓/军鼓/踩镲，已跳过。`,
};

/** "竖琴音域 F#3–F#5" or "电路音域 F#1–F#7", depending on the track. */
function rangeTextFor(w, ctx) {
  if (Number.isFinite(w.low) && Number.isFinite(w.high)) {
    const name = w.instrument ? instrumentName(w.instrument) : '电路';
    return `${name}音域 ${pitchRangeLabel({ low: w.low, high: w.high })}`;
  }
  const range = ctx.rangeFor(w);
  const info = ctx.infoFor(w.trackIndex);
  const label =
    info && info.effective !== 'piano' && info.effective !== 'drums'
      ? `${instrumentName(info.effective)}音域`
      : '电路音域';
  return range ? `${label} ${pitchRangeLabel(range)}` : label;
}

const OUT_OF_RANGE_ACTION_TEXT = {
  warn: '提示并八度移调',
  octave: '自动八度移调',
  clamp: '改用最近可用音',
  drop: '跳过',
};

/** Short Chinese heading per warning code, for the list on the check step. */
const WARN_TITLE = {
  COMMAND_PLAYBACK_REQUIREMENTS: '命令播放的额外要求',
  COMMAND_SOUND_PRESSURE: '声音数量接近客户端上限',
  COMMAND_STRUCTURE_SIZE: '命令方块数量偏多',
  POLYPHONY_EXCEEDED: '和弦超出单列容量',
  FORCE_MERGE_LEAD_IN: '合并音轨带来的统一延迟',
  FANOUT_EXPANDED: '和弦使用多级分支',
  STARTUP_LEAD_IN: '全曲统一延后',
  OUT_OF_RANGE: '音符超出乐器音域',
  TIMING_ADJUSTED: '触发时刻被调整',
  TRACK_SPLIT: '音轨被拆分',
  SPATIAL_DRIFT: '多轨对齐出现偏差',
  INSTRUMENT_UNKNOWN: '乐器未能识别',
  INSTRUMENT_SUBSTITUTED: '扩展模式下换了相近音色',
  INSTRUMENT_OCTAVE_SHIFT: '整轨移到了别的八度',
  INSTRUMENT_RANGE_OVERFLOW: '音域跨度超出两个八度',
  DRUM_NOTES_DROPPED: '打击乐音符被跳过',
};

function warnSeverity(code) {
  if (
    code === 'TIMING_ADJUSTED' ||
    code === 'TRACK_SPLIT' ||
    code === 'POLYPHONY_EXCEEDED' ||
    code === 'SPATIAL_DRIFT' ||
    code === 'COMMAND_SOUND_PRESSURE' ||
    code === 'COMMAND_STRUCTURE_SIZE' ||
    code === 'COMMAND_PLAYBACK_REQUIREMENTS' ||
    code === 'INSTRUMENT_RANGE_OVERFLOW' ||
    code === 'DRUM_NOTES_DROPPED'
  ) {
    return 'warn';
  }
  return 'info';
}

/**
 * The cell a warning is about, when that can be worked out.
 *
 * A placed note carries its own cell. A note that was dropped before placement has none, so
 * fall back to the nearest group in time on the same track: that is where it would have
 * been, which is enough to go and look.
 */
function locateWarning(result, warning) {
  if (Number.isFinite(warning.x) && Number.isFinite(warning.z)) {
    return { x: warning.x, z: warning.z };
  }
  const groups = (result?.placed || []).filter((group) => group.trackIndex === warning.trackIndex);
  if (groups.length === 0 || !Number.isFinite(warning.tick)) return null;
  let best = groups[0];
  for (const group of groups) {
    if (Math.abs(group.tick - warning.tick) < Math.abs(best.tick - warning.tick)) best = group;
  }
  return { x: best.x, z: best.zBase };
}

/** Name the track a warning is about, falling back to its index. */
function trackLabel(result, index) {
  const track = (result?.tracks || []).find((t) => t.index === index);
  return track && track.name ? `轨${index}「${track.name}」` : `轨${index}`;
}

/** The context every warning text needs: a range, a track name, a readable time. */
function warningContext(result) {
  const infoFor = (index) => (result?.trackInstruments || []).find((entry) => entry.trackIndex === index);

  return {
    range: result?.pitchRange,
    infoFor,
    /**
     * The range a warning is about.
     *
     * A fixed-instrument note carries its own `instrument`/`low`/`high`. The
     * five-slot piano extension uses the result's piano span; drums have no range.
     */
    rangeFor: (warning) => {
      if (Number.isFinite(warning.low) && Number.isFinite(warning.high)) {
        return { low: warning.low, high: warning.high };
      }
      const info = infoFor(warning.trackIndex);
      if (info) {
        if (info.effective === 'piano') return result?.pitchRange ?? null;
        if (info.effective === 'drums') return null;
        return instrumentRange(info.effective);
      }
      return result?.pitchRange ?? null;
    },
    label: (index) => trackLabel(result, index),
    at: (tick) => `tick ${tick}（${(tick / 20).toFixed(2)} 秒）`,
  };
}

function warningTitle(code) {
  return WARN_TITLE[code] || code;
}

function warningText(result, warning) {
  const build = WARN_TEXT[warning.code];
  return build ? build(warning, warningContext(result)) : JSON.stringify(warning);
}

export {
  WARNING_DISPLAY_LIMIT,
  WARN_TEXT,
  OUT_OF_RANGE_ACTION_TEXT,
  locateWarning,
  trackLabel,
  warnSeverity,
  warningContext,
  warningText,
  warningTitle,
};
