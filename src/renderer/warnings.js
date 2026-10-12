import { $ } from './state.js';
import { create } from './dom.js';
import { pitchName, pitchRangeLabel } from './pitch.js';
import { switchTab } from './workflow.js';
import { focusPreviewCell } from './preview.js';

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
    `超出电路音域 ${pitchRangeLabel(ctx.range)}，处理方式：` +
    `${OUT_OF_RANGE_ACTION_TEXT[w.action] || w.action}`,
  TIMING_ADJUSTED: (w, ctx) =>
    `${ctx.label(w.trackIndex)} · z${w.z} 行 · ${ctx.at(w.tick)} 的音实际在 ` +
    `${ctx.at(w.actual)} 触发，偏移 ${w.actual - w.tick > 0 ? '+' : ''}${w.actual - w.tick} 游戏刻`,
  TRACK_SPLIT: (w) => `tick ${w.tick}：${w.notes} 个音密集放不下，已自动拆到新音轨`,
  SPATIAL_DRIFT: (w) => `tick ${w.tick}：该处空间偏差 ${w.drift} 格，超出多轨对齐容差`,
};

const OUT_OF_RANGE_ACTION_TEXT = {
  warn: '提示并八度移调',
  octave: '自动八度移调',
  clamp: '改用最近可用音',
  drop: '跳过',
};

function warnSeverity(code) {
  if (
    code === 'TIMING_ADJUSTED' ||
    code === 'TRACK_SPLIT' ||
    code === 'POLYPHONY_EXCEEDED' ||
    code === 'SPATIAL_DRIFT' ||
    code === 'COMMAND_SOUND_PRESSURE' ||
    code === 'COMMAND_STRUCTURE_SIZE' ||
    code === 'COMMAND_PLAYBACK_REQUIREMENTS'
  ) {
    return 'warn';
  }
  return 'info';
}

/**
 * The cell a warning is about, when that can be worked out.
 *
 * A placed note carries its own cell. A note that was dropped before placement has
 * none, so fall back to the nearest group in time on the same track: that is where it
 * would have been, which is enough to go and look.
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

/**
 * Render the warning list for one result.
 *
 * Warnings carry where they are about - the track, the tick, and for a placed note the
 * Z row - because "tick 846 is off by 4" is not actionable on a song with tens of
 * thousands of ticks when nothing says which note block is meant.
 */
function renderWarnings(result) {
  const warnings = result?.warnings ?? [];
  const ctx = {
    range: result?.pitchRange,
    label: (index) => trackLabel(result, index),
    at: (tick) => `tick ${tick}（${(tick / 20).toFixed(2)} 秒）`,
  };
  const box = $('warnings');
  box.className = warnings.length === 0 ? 'empty-state compact-empty' : '';
  box.replaceChildren();

  const badge = $('warnCount');
  badge.textContent = String(warnings.length);
  badge.className = 'badge' + (warnings.length > 0 ? ' has' : '');

  if (warnings.length === 0) {
    box.append(
      create('div', 'empty-icon', '✓'),
      create('h3', null, '无告警'),
      create('p', null, '所有音符都落在期望时刻，当前没有需要处理的问题。'),
    );
    return;
  }

  // One warning per note is normal in a dense passage, so hundreds of entries of the
  // same kind are possible; collapse them by code.
  const counts = new Map();
  for (const w of warnings) counts.set(w.code, (counts.get(w.code) || 0) + 1);

  box.append(create('p', 'hint', [...counts.entries()].map(([c, n]) => `${c}×${n}`).join('　')));

  const shown = warnings.slice(0, WARNING_DISPLAY_LIMIT);
  for (const w of shown) {
    const item = create('div', `warnitem ${warnSeverity(w.code)}`);
    item.append(
      create('span', 'code', w.code),
      create('span', 'detail', (WARN_TEXT[w.code] || (() => JSON.stringify(w)))(w, ctx)),
    );
    const cell = locateWarning(result, w);
    if (cell) {
      const jump = create('button', 'warnjump', '定位');
      jump.type = 'button';
      jump.title = `在红石布线中定位 X${cell.x} · Z${cell.z}`;
      jump.addEventListener('click', () => {
        switchTab('preview');
        focusPreviewCell(cell.x, cell.z);
      });
      item.append(jump);
    }
    box.append(item);
  }
  if (warnings.length > shown.length) {
    box.append(create('p', 'hint', `…还有 ${warnings.length - shown.length} 条未显示`));
  }
}

export { WARN_TEXT, OUT_OF_RANGE_ACTION_TEXT, warnSeverity, renderWarnings };
