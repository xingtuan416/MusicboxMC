/**
 * The renderer's whole behaviour: an eight-step flow wired to the main process.
 *
 * Every value shown here comes from an `AnalyzeResult` or a `GenerateResult`, or from a
 * path the user picked in a system dialog. There is no sample data in this file: the
 * earlier prototype invented song names, note counts and block totals, and the interface
 * presented them as if they were real.
 *
 * Rendering is intentionally plain DOM work on a markup tree that is fixed at build time.
 * There is no framework here, so anything dynamic reads better as one small function per
 * step than as a general renderer.
 */

import { devLog, initDevMode, isDevMode, refreshDev, registerDev, setDevMode, wrapApi } from './devmode.js';
import { instrumentName } from './instruments.js';
import { maybePromptForPack, savePack } from './resourcepack.js';
import { focusPreviewCell, panPreview, previewPosition, renderPreview } from './preview.js';
import {
  locateWarning,
  MERGE_MODE_TEXT,
  WARNING_DISPLAY_LIMIT,
  warnSeverity,
  warningText,
  warningTitle,
} from './warningText.js';

// Every call is logged for the developer panel; the wrapper rethrows unchanged.
const api = wrapApi(window.musicbox);

/** Elements are looked up once; the markup is static, so a missing one is a bug. */
const $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element;
};

const steps = [...document.querySelectorAll('.screen-step')];
const stepNodes = [...document.querySelectorAll('.step-node')];

const state = {
  step: 1,
  /** Absolute path of the chosen MIDI, as returned by the main process. */
  midiPath: null,
  /** SongSummary from analyze(). */
  song: null,
  /** TrackSummary[] plus the user's selection. */
  tracks: [],
  /** Source track index whose lane is kept closest to the listener. */
  leadTrackIndex: null,
  /** 'velocity' | 'balance' | 'manual' | null */
  leadBasis: null,
  /** Whether the smart recommendation is the one in force; any manual edit clears it. */
  smartSelection: true,
  /** The routing summary the last measurement produced, or null before one ran. */
  smartMeasured: null,
  /** What the measurement was run for; a changed track selection invalidates it. */
  smartSignature: '',
  /** Resource-pack advice from that measurement; null means "derive it from the mode". */
  packRecommended: null,
  /** Bumped per measurement so a slow answer cannot overwrite newer settings. */
  smartToken: 0,
  /** Last layout measurement shown by developer mode on the configuration step. */
  devMeasure: null,
  /** Folder the schematic will be written into. The file name is kept separately. */
  outputDir: null,
  /** Main-process grant for `outputDir`; this is the only thing that authorizes a write. */
  outputDirToken: null,
  result: null,
  /** 'extended' keeps the five-slot piano range; 'native' follows every MIDI instrument. */
  instrumentMode: 'extended',
  dMax: 14,
  outOfRange: 'warn',
  backend: 'redstone',
  /** 'off' | 'same' | 'force' - one value, because merge and force-merge conflict. */
  merge: 'off',
  /** Fold sparse tracks onto neighbouring lanes. Independent of the merge choice. */
  laneSharing: true,
  /** A source track with fewer notes than this counts as sparse; mirrors the main default. */
  laneShareSparseBelow: 50,
  /** Center the lead lane in Z so the player stands on it. Can be the wider layout. */
  centerLead: true,
  /** Write lane signs into the schematic so the player can tell which lane is the lead. */
  annotateLanes: true,
  laneRide: true,
  author: 'MusicboxMC',
  commandBudget: 65536,
  baseTps: 20,
  sound: true,
};

/* ────────────────────────────────────────────────────────────────────────────
 * Sound
 *
 * Synth tones rather than audio files: the app ships no samples, and the point of the
 * feedback is to confirm an action, not to be music. The pitch carries information -
 * advancing a step raises it, and a failure drops to a low sawtooth so the two are
 * distinguishable without looking at the screen.
 * ──────────────────────────────────────────────────────────────────────────── */

let audioContext = null;

function playNote(frequency, type = 'sine', duration = 0.08) {
  if (!state.sound) return;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!audioContext) audioContext = new Ctor();
    if (audioContext.state === 'suspended') void audioContext.resume();

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
    gain.gain.setValueAtTime(0.08, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
  } catch {
    // Audio is a nicety; never let it break the flow.
  }
}

/** A short rising arpeggio, used when a schematic is finished. */
function playSuccess() {
  [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
    setTimeout(() => playNote(frequency, 'triangle', 0.28), index * 75);
  });
}

function playFailure() {
  playNote(220, 'sawtooth', 0.25);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ──────────────────────────────────────────────────────────────────────────── */

let toastTimer = null;
function notify(text) {
  const element = $('statusToast');
  element.textContent = text;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3200);
}

const number = (value) => value.toLocaleString('en-US');

function bytesText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Turn a MIDI path into a safe default file name for the save dialog. */
function suggestedName(path, songName) {
  const base = (songName || String(path).split(/[\\/]/).pop() || 'Musicbox')
    .replace(/\.(mid|midi)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return `${base || 'Musicbox'}.litematic`;
}

/** The overall bounding box of every region, which is what the user has to fit in a world. */
function unionSize(regions) {
  if (!regions || regions.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const region of regions) {
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], region.position[axis]);
      max[axis] = Math.max(max[axis], region.position[axis] + region.size[axis] - 1);
    }
  }
  return { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step navigation
 * ──────────────────────────────────────────────────────────────────────────── */

function goStep(target) {
  const next = Math.max(1, Math.min(steps.length, Number(target)));
  state.step = next;

  steps.forEach((section, index) => section.classList.toggle('active', index + 1 === next));
  $('btnPrevStep').classList.toggle('is-hidden', next === 1);
  stepNodes.forEach((node, index) => {
    node.classList.toggle('current', index + 1 === next);
    node.classList.toggle('done', index + 1 < next);
  });

  playNote(330 + next * 40, 'sine', 0.08);

  // Entering the configuration step measures the smart routing once, so the values shown
  // there are exactly the ones the generator will use. The measurement is a dry run of the
  // whole pipeline, so it only runs again when the track selection changed.
  if (next === 4 && state.smartSelection && state.smartSignature !== selectionSignature()) {
    void applySmartSelection();
  }
  if (next === 4) scheduleDevMeasure(0);

  // The pack nudge belongs on the last step, not on the check step: arriving at the check
  // step with a modal over it hides the very thing the user was sent there to read.
  if (next === 8 && state.result?.outputPath) {
    maybePromptForPack(state.packRecommended ?? state.instrumentMode === 'extended');
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 2: import
 * ──────────────────────────────────────────────────────────────────────────── */

/** 'empty' | 'loading' | 'error' | 'loaded' */
function setImportView(mode) {
  $('importEmpty').style.display = mode === 'empty' ? 'flex' : 'none';
  $('importLoading').style.display = mode === 'loading' ? 'flex' : 'none';
  $('importError').style.display = mode === 'error' ? 'flex' : 'none';
  $('importLoaded').style.display = mode === 'loaded' ? 'flex' : 'none';
  $('btnStep2Next').disabled = mode !== 'loaded';
}

function showImportError(message) {
  // The reason comes from the main process, which names the actual problem - a corrupt
  // header, an SMPTE timebase, unsupported timing. Guessing it here would be a lie half
  // the time.
  $('importErrHeading').textContent = '这个文件读不了';
  $('importErrDetail').textContent = message;
  setImportView('error');
  playFailure();
}

async function loadMidi(path) {
  if (!path) return;
  state.midiPath = path;
  setImportView('loading');
  try {
    const result = await api.analyze(path);
    state.song = result.song;
    // A MIDI file routinely carries tracks that hold no notes - a conductor track, or one
    // whose channel was never used. They compile to nothing, so listing them offers the
    // user a choice that does nothing.
    state.tracks = result.tracks
      .filter((track) => track.noteCount > 0)
      .map((track) => ({ ...track, checked: true }));
    state.leadTrackIndex = result.recommendedLeadTrackIndex ?? null;
    state.leadBasis = result.recommendedLeadBasis ?? null;
    // A new song starts from the recommendation again: the previous measurements were
    // made for a different track list and cannot be reused.
    state.smartSelection = true;
    state.smartMeasured = null;
    state.smartSignature = '';
    state.packRecommended = null;

    $('midiFileTitle').textContent = result.file;
    $('valDuration').textContent = result.song.durationText;
    $('valBpm').textContent = `${result.song.baseBpm} BPM`;
    $('valTracks').textContent = String(state.tracks.length);
    $('valNotes').textContent = number(result.song.noteCount);

    $('fileNameInput').value = suggestedName(path, result.song.name);

    const dropped = result.tracks.length - state.tracks.length;
    $('trackFilterHint').style.display = dropped > 0 ? 'block' : 'none';
    $('trackFilterHint').textContent =
      dropped > 0 ? `已过滤 ${dropped} 条不含音符的音轨（指挥轨，或从未使用的通道）。` : '';

    renderTracks();
    syncOutputText();
    setImportView('loaded');
    playNote(660, 'triangle', 0.12);

    if (result.song.noteCount === 0) {
      notify('这个文件里没有音符');
    }
  } catch (error) {
    showImportError(error?.message || String(error));
  }
}

async function chooseMidiFile() {
  try {
    const path = await api.chooseMidi();
    if (!path) return; // Cancelled.
    await loadMidi(path);
  } catch (error) {
    showImportError(error?.message || String(error));
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 3: tracks
 * ──────────────────────────────────────────────────────────────────────────── */

function renderTracks(popIndex = -1) {
  const box = $('trackListBox');
  box.replaceChildren();

  state.tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = `track-item ${track.checked ? 'checked' : 'unchecked'}`;
    row.dataset.trackIdx = String(index);
    // Only the row whose state changed gets the tick animation. The rest are being
    // redrawn, not toggled, and animating them reads as the whole list reacting.
    if (index === popIndex) row.dataset.pop = 'true';

    const left = document.createElement('div');
    left.className = 'track-item-left';

    const check = document.createElement('div');
    check.className = 'check-box';
    check.innerHTML = track.checked
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>'
      : '';

    const text = document.createElement('div');
    // Two lines, as the design intends: the heading carries the identity - which track it
    // is, what the file calls it, and what it sounds as - and the small line carries the
    // count. Putting the instrument on the small line instead reads as a data dump.
    const name = document.createElement('div');
    name.className = 'track-name';
    const heading = track.name ? `音轨 ${track.index + 1}：${track.name}` : `音轨 ${track.index + 1}`;
    const kind = track.percussion ? `${track.instrument} · 打击乐` : track.instrument;
    name.textContent = kind ? `${heading}（${kind}）` : heading;
    const meta = document.createElement('div');
    meta.className = 'track-meta tnum';
    meta.textContent = `${number(track.noteCount)} 个音符 · 平均力度 ${Math.round(track.meanVelocity * 100)}%`;

    const detected =
      track.detectedInstrument === 'drums' ? '打击乐' : instrumentName(track.detectedInstrument);
    const sourceText =
      track.detectionSource === 'gm'
        ? `GM ${track.program ?? '?'}`
        : track.detectionSource === 'name'
          ? '轨道名'
          : track.detectionSource === 'drum'
            ? '鼓通道'
            : '未识别，按竖琴处理';
    const detection = document.createElement('div');
    detection.className = 'track-meta';
    detection.textContent =
      track.detectionSource === 'fallback' ? '识别：未识别，按竖琴处理' : `识别：${detected} · ${sourceText}`;

    text.append(name, meta, detection);
    left.append(check, text);
    row.append(left);
    box.append(row);
  });

  const chosen = state.tracks.filter((track) => track.checked);
  const notes = chosen.reduce((sum, track) => sum + track.noteCount, 0);
  $('trackStatText').textContent =
    chosen.length > 0
      ? `已选 ${chosen.length} / ${state.tracks.length} 条音轨 · 共 ${number(notes)} 个音符`
      : '至少保留一条音轨才能生成';
  $('btnStep3Next').disabled = chosen.length === 0;
  $('btnToggleAllTracks').textContent = chosen.length === state.tracks.length ? '取消全选' : '全选';
  syncLeadPicker();
}

/**
 * The ordering the main process uses, repeated here so the picker cannot recommend one
 * track while the layout stands the player somewhere else. Velocity alone decides it,
 * drums included: the loudest track is what the listener hears as the centre.
 */
function preferredLead(tracks) {
  const pool = tracks.filter((track) => track.checked && track.noteCount > 0);
  const ranked = [...pool].sort((a, b) => {
    const velocity = b.meanVelocity - a.meanVelocity;
    if (velocity !== 0) return velocity;
    const notes = b.noteCount - a.noteCount;
    return notes !== 0 ? notes : a.index - b.index;
  });
  const first = ranked[0];
  if (!first) return null;
  return { track: first, basis: 'velocity' };
}

/** The sentence under the picker: which track, and why it is the centre. */
function leadReasonText(selected) {
  if (!selected) return '至少选择一条音轨后才能指定主音轨。';
  const label = `轨 ${selected.index + 1}「${selected.name || selected.instrument}」`;
  if (state.leadBasis === 'manual') return `${label}：手动指定，玩家会站在这一轨上。`;
  return `${label}：平均 MIDI 力度最高，自动作为听感中心。`;
}

function syncLeadPicker() {
  const chosen = state.tracks.filter((track) => track.checked && track.noteCount > 0);
  let selected = chosen.find((track) => track.index === state.leadTrackIndex);
  if (!selected) {
    // A lead that was unchecked falls back to the next recommendation, rather than
    // leaving the layout without a centre.
    const fallback = preferredLead(chosen);
    state.leadTrackIndex = fallback?.track.index ?? null;
    state.leadBasis = fallback?.basis ?? null;
    selected = fallback?.track;
  }

  const select = $('leadTrackSelect');
  select.replaceChildren();
  for (const track of chosen) {
    const option = document.createElement('option');
    option.value = String(track.index);
    const name = track.name ? ` · ${track.name}` : '';
    option.textContent = `轨 ${track.index + 1}${name}（力度 ${Math.round(track.meanVelocity * 100)}%）`;
    select.append(option);
  }
  select.disabled = chosen.length === 0;
  if (selected) select.value = String(selected.index);

  const badge = $('leadBadge');
  const manual = state.leadBasis === 'manual';
  badge.textContent = !selected ? '未指定' : manual ? '手动指定' : '自动推荐';
  badge.dataset.state = !selected || manual ? 'manual' : 'auto';
  $('leadReason').textContent = leadReasonText(selected);
}

const FOLD_PADDING_BOTTOM = 18;

/**
 * Open or close one fold card.
 *
 * The panel is display:none while closed, so it cannot be transitioned in CSS. It is
 * shown first and then animated from zero height; closing measures the rendered height
 * and animates back before the class is removed. Height is cleared afterwards so a card
 * that grows later (a longer summary line, a reflowed option box) is not clipped.
 */
function toggleFoldCard(id) {
  const card = id ? document.getElementById(id) : null;
  if (!card) return;
  const content = card.querySelector('.fold-content');
  const trigger = card.querySelector('.fold-trigger');
  const open = !card.classList.contains('open');
  if (trigger) trigger.setAttribute('aria-expanded', String(open));
  if (!content || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    card.classList.toggle('open', open);
    return;
  }

  if (open) {
    card.classList.add('open');
    const target = Math.max(0, content.scrollHeight - FOLD_PADDING_BOTTOM);
    content.style.overflow = 'hidden';
    const anim = content.animate(
      [
        { height: '0px', paddingBottom: '0px', opacity: 0.35 },
        { height: `${target}px`, paddingBottom: `${FOLD_PADDING_BOTTOM}px`, opacity: 1 },
      ],
      { duration: 200, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    );
    anim.onfinish = () => {
      content.style.height = '';
      content.style.overflow = '';
    };
    return;
  }

  const current = content.getBoundingClientRect().height;
  content.style.overflow = 'hidden';
  const anim = content.animate(
    [
      {
        height: `${Math.max(0, current - FOLD_PADDING_BOTTOM)}px`,
        paddingBottom: `${FOLD_PADDING_BOTTOM}px`,
        opacity: 1,
      },
      { height: '0px', paddingBottom: '0px', opacity: 0 },
    ],
    { duration: 160, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
  );
  anim.onfinish = () => {
    card.classList.remove('open');
    content.style.height = '';
    content.style.overflow = '';
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 4: configuration
 * ──────────────────────────────────────────────────────────────────────────── */

/** What a measurement depends on; a different track list or lead needs a new measurement. */
function selectionSignature() {
  const excluded = state.tracks.filter((track) => !track.checked).map((track) => track.index);
  const lead = state.leadBasis === 'manual' ? state.leadTrackIndex : '';
  return `${state.midiPath}|${state.backend}|${excluded.join(',')}|${lead}`;
}

/** One line describing what the measurement decided. */
function smartRoutingText(info) {
  if (!info) return '';
  const mode = info.instrumentMode === 'extended' ? '扩展竖琴音域（需资源包）' : '原版乐器';
  if (state.backend === 'command') return `${mode} · 命令播放不判定听距、合并与借道`;
  const merge = MERGE_MODE_TEXT[info.mergeMode] ?? MERGE_MODE_TEXT.off;
  return `${mode} · ${merge} · 最远 ${info.radiusZ} 格`;
}

function syncSmartPanel() {
  const badge = $('smartBadge');
  const button = $('btnSmartApply');
  if (state.smartSelection && state.smartMeasured) {
    badge.textContent = '已应用';
    badge.dataset.state = 'auto';
    button.textContent = '重新计算智能推荐';
    $('smartConfigHint').textContent =
      '已按当前音轨选好乐器模式、合并方式与稀疏音轨借道，下面显示的数值就是生成时会用的；改动下面的设置会切回手动。';
    $('smartApplyResult').textContent = smartRoutingText(state.smartMeasured);
  } else if (state.smartSelection) {
    badge.textContent = '待计算';
    badge.dataset.state = 'busy';
    button.textContent = '应用智能推荐';
    $('smartConfigHint').textContent =
      '按所选音轨自动判定乐器模式、合并方式与稀疏音轨借道，进入这一步就会算一次。';
    $('smartApplyResult').textContent = '';
  } else {
    badge.textContent = '手动';
    badge.dataset.state = 'manual';
    button.textContent = '恢复智能推荐';
    $('smartConfigHint').textContent =
      '已切回手动：下面的乐器模式、合并方式、借道开关和资源包提示按当前设置执行。点按钮可以重新按音轨特征选一次。';
    $('smartApplyResult').textContent = '';
  }
}

/**
 * Measure the smart routing and apply it.
 *
 * The result is written into the same state the manual controls write to, so there is one
 * source of truth: if the shelf says "同乐器合并", that is what the generator will do.
 * Writing the recommendation into a separate label was the earlier bug - the checkbox
 * claimed smart mode while the summaries and the file followed the manual values.
 */
async function applySmartSelection() {
  if (!state.midiPath) return;
  const token = ++state.smartToken;
  const signature = selectionSignature();
  const button = $('btnSmartApply');
  button.disabled = true;
  $('smartBadge').textContent = '计算中…';
  $('smartBadge').dataset.state = 'busy';
  try {
    const { info, error } = await api.plan(state.midiPath, generateOptions());
    if (token !== state.smartToken) return;
    if (!info) {
      state.smartSelection = false;
      state.smartMeasured = null;
      syncSummary();
      $('smartBadge').textContent = '无法计算';
      $('smartBadge').dataset.state = 'error';
      $('smartConfigHint').textContent =
        `智能推荐没能算出结果：${error || '生成器没有给出原因'}。现在按下面的手动设置生成。`;
      return;
    }
    state.smartMeasured = info;
    state.smartSignature = signature;
    state.smartSelection = true;
    state.instrumentMode = info.instrumentMode;
    // Merging and the Z span only exist for the redstone backend. Sharing is not one of the
    // three merge boxes, and the generator re-derives it from the switch, so the boxes keep
    // the unmerged choice rather than inventing a fourth selected state.
    if (state.backend !== 'command') state.merge = info.mergeMode === 'share' ? 'off' : info.mergeMode;
    state.packRecommended = info.resourcePackRecommended;
    syncSummary();
  } catch (failure) {
    if (token !== state.smartToken) return;
    state.smartSelection = false;
    state.smartMeasured = null;
    syncSummary();
    $('smartBadge').textContent = '无法计算';
    $('smartBadge').dataset.state = 'error';
    $('smartConfigHint').textContent =
      `智能推荐失败：${failure?.message || failure}。现在按下面的手动设置生成。`;
  } finally {
    button.disabled = false;
  }
}

/**
 * Paint the option boxes from the state.
 *
 * Applying the recommendation changes the mode and merge mode without a click, so the
 * highlighted boxes have to follow the state; otherwise the fold keeps showing the value
 * the user had before while the generator uses the recommended one.
 */
function syncOptionBoxes() {
  const values = {
    instrument: state.instrumentMode,
    merge: state.merge,
    range: state.outOfRange,
    backend: state.backend,
  };
  for (const box of document.querySelectorAll('[data-cfg-group]')) {
    const group = box.getAttribute('data-cfg-group');
    box.classList.toggle('selected', values[group] === box.getAttribute('data-cfg-val'));
  }
}

function syncSummary() {
  syncSmartPanel();
  syncOptionBoxes();
  const extended = state.instrumentMode === 'extended';
  $('sumPitch').textContent = extended
    ? `扩展竖琴音域（需配套资源包）· 钢琴 F#1–F#7 · 最多 ${state.dMax} 音同时`
    : `原版乐器 · 各乐器两个八度 · 最多 ${state.dMax} 音同时`;
  // A measurement knows whether the pack helps this song; without one, the instrument
  // mode is the only evidence there is.
  const packWanted = state.packRecommended ?? extended;
  $('packTitle').textContent = packWanted
    ? '配套资源包（可选，保存后自行安装）'
    : '配套资源包（当前设置不需要）';
  $('packDescription').textContent = packWanted
    ? '只统一扩展竖琴那五个音色槽的钢琴采样：音域不变（F#1–F#7 来自五个扩展槽，不是这个包）；被占用的原生 bass/guitar/flute/bell 已改用替代表，不受它影响。保存后放进 .minecraft/resourcepacks/ 再自行启用。'
    : extended
      ? '当前设置用不到这个包：它只改竖琴那五个音色槽的采样，不改变音域，也不影响合并方式。'
      : '原版乐器模式每条轨使用自己的音色；装了这个包反而会把原生 bass、guitar、flute、bell 也替换成钢琴。';
  $('sumRange').textContent = {
    warn: '提示并八度移调',
    octave: '自动八度移调',
    clamp: '改用最近可用音',
    drop: '跳过这些音符',
  }[state.outOfRange];
  $('sumBackend').textContent = state.backend === 'command' ? '命令方块播放' : '红石电路';
  const mergeText =
    {
      off: '每条音轨各自一条主线',
      same: '同乐器合并到一条主线',
      force: '全曲强制合并为一条主线',
    }[state.merge] ?? '每条音轨各自一条主线';
  const shareSwitch = $('btnLaneSharing');
  const command = state.backend === 'command';
  shareSwitch.setAttribute('aria-checked', state.laneSharing ? 'true' : 'false');
  // Command playback has no lanes, so a switch that changes nothing must not look usable.
  shareSwitch.disabled = command;
  shareSwitch.title = command ? '命令播放没有轨道排布，借道不适用' : '';
  const sparseInput = $('laneShareSparse');
  sparseInput.value = String(state.laneShareSparseBelow);
  sparseInput.disabled = command || !state.laneSharing;
  // A switch that is on but cannot do anything has to explain itself in place.
  const shareHint = $('laneShareHint');
  if (shareHint) {
    if (command) {
      shareHint.hidden = false;
      shareHint.textContent = '命令播放没有轨道排布，借道不适用。';
    } else if (state.merge === 'same') {
      shareHint.hidden = false;
      shareHint.textContent =
        '当前是「同乐器合并」：合并之后还会在合并出来的轨道上再试一次，只有音符很少的轨道才会被折进相邻轨道。';
    } else {
      shareHint.hidden = true;
      shareHint.textContent = '';
    }
  }
  const centerSwitch = $('btnCenterLead');
  if (centerSwitch) {
    centerSwitch.setAttribute('aria-checked', state.centerLead ? 'true' : 'false');
    centerSwitch.disabled = command;
    centerSwitch.title = command ? '命令播放没有轨道排布，按主轨排序不适用' : '';
    const centerHint = $('centerLeadHint');
    if (centerHint) {
      if (command) {
        centerHint.hidden = false;
        centerHint.textContent = '命令播放没有轨道排布，按主轨排序不适用。';
      } else {
        centerHint.hidden = true;
        centerHint.textContent = '';
      }
    }
  }
  const annotateSwitch = $('btnAnnotateLanes');
  if (annotateSwitch) {
    annotateSwitch.setAttribute('aria-checked', state.annotateLanes ? 'true' : 'false');
    annotateSwitch.disabled = command;
    annotateSwitch.title = command ? '命令播放没有轨道排布，注释牌不适用' : '';
    const annotateHint = $('annotateLanesHint');
    if (annotateHint) {
      annotateHint.hidden = !command;
      annotateHint.textContent = command ? '命令播放没有轨道排布，注释牌不适用。' : '';
    }
  }
  const rideSwitch = $('btnLaneRide');
  if (rideSwitch) {
    rideSwitch.setAttribute('aria-checked', state.laneRide ? 'true' : 'false');
    rideSwitch.disabled = command;
    rideSwitch.title = command ? '命令播放没有轨道排布，取电不适用' : '';
    const rideHint = $('laneRideHint');
    if (rideHint) {
      if (command) {
        rideHint.hidden = false;
        rideHint.textContent = '命令播放没有轨道排布，取电不适用。';
      } else {
        rideHint.hidden = true;
        rideHint.textContent = '';
      }
    }
  }
  // A forced merge leaves one spine: borrowing and riding have nothing to act on, so the
  // cards step aside instead of sitting there greyed out.
  const forced = state.merge === 'force';
  const shareCard = $('laneShareCard');
  if (shareCard) shareCard.hidden = forced;
  const rideCard = $('laneRideCard');
  if (rideCard) rideCard.hidden = forced;
  const shareText = state.laneSharing ? ` · 借道 <${state.laneShareSparseBelow} 音` : ' · 不借道';
  const centerText = state.centerLead ? ' · 按主轨排序' : ' · 按文件顺序';
  const annotateText = state.annotateLanes ? ' · 注释牌' : ' · 无注释牌';
  const rideText = state.laneRide ? ' · 轨道取电' : ' · 不取电';
  const tpsText = state.baseTps === 20 ? '' : ` · 基准 ${state.baseTps} TPS`;
  $('sumMisc').textContent =
    `${mergeText}${shareText}${rideText}${centerText}${annotateText}${tpsText} · 作者 ${state.author.trim() || 'MusicboxMC'}`;
  $('commandBudgetField').style.display = state.backend === 'command' ? 'flex' : 'none';
  // The readout is dev-only and cheap to skip; every option change lands here.
  scheduleDevMeasure();
}

/** Map the interface state onto the generator's options, and nothing more. */
function generateOptions() {
  const chosen = state.tracks.filter((track) => track.checked);
  const options = {
    baseTps: state.baseTps,
    dMax: state.dMax,
    outOfRange: state.outOfRange,
    instrumentMode: state.instrumentMode,
    // The generator works on exclusions, so a track the user cleared is left out.
    excludeTracks: state.tracks.filter((track) => !track.checked).map((track) => track.index),
    commandPlayback: state.backend === 'command',
    mergeSameInstrument: state.merge === 'same',
    forceMergeSameInstrument: state.merge === 'force',
    smartSelection: state.smartSelection,
    // A visible switch, so it applies with or without smart routing.
    laneSharing: state.laneSharing,
    laneShareSparseBelow: state.laneShareSparseBelow,
    centerLead: state.centerLead,
    annotateLanes: state.annotateLanes,
    laneRide: state.laneRide,
  };
  // A lead the user picked by hand keeps centring the lanes after smart routing is off; an
  // automatically chosen one only means something inside the smart recommendation.
  if (state.leadTrackIndex !== null && (state.smartSelection || state.leadBasis === 'manual')) {
    options.leadTrackIndex = state.leadTrackIndex;
  }
  if (state.author.trim()) options.author = state.author.trim();
  if (state.backend === 'command') options.commandChainBudget = state.commandBudget;
  if (chosen.length === 0) options.excludeTracks = state.tracks.map((track) => track.index);
  return options;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 5: output location
 * ──────────────────────────────────────────────────────────────────────────── */

function outputFileName() {
  const raw = $('fileNameInput').value.trim() || suggestedName(state.midiPath, state.song?.name);
  return raw.toLowerCase().endsWith('.litematic') ? raw : `${raw}.litematic`;
}

function syncOutputText() {
  const name = outputFileName();
  $('fullPathText').textContent = state.outputDir
    ? `完整路径：${state.outputDir}\\${name}`
    : `完整路径：尚未选择文件夹（文件名 ${name}）`;
  $('outputDirText').textContent = state.outputDir ?? '尚未选择文件夹';

  // Writing a schematic is what this step is for, so it stays disabled until the main
  // process has authorized a folder. `runGeneration` checks the same thing, because a
  // disabled button is a hint and not a guarantee.
  $('btnStartGen').disabled = !state.outputDirToken;
}

async function chooseOutputFile() {
  try {
    const grant = await api.chooseDirectory();
    if (!grant) return; // Cancelled.
    state.outputDir = grant.path;
    state.outputDirToken = grant.token;
    syncOutputText();
    playNote(480, 'sine', 0.08);
  } catch (error) {
    notify(`无法选择文件夹：${error?.message || error}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 6: generation
 * ──────────────────────────────────────────────────────────────────────────── */

let elapsedTimer = null;

function startElapsed() {
  const startedAt = Date.now();
  $('genElapsed').textContent = '0.0s';
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    $('genElapsed').textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  }, 100);
}

/** Show the failure view with the generator's own reason, rather than a generic message. */
function showGenerateError(message, heading = '生成失败') {
  clearInterval(elapsedTimer);
  $('genRunningBox').style.display = 'none';
  $('genErrorBox').style.display = 'flex';
  $('genErrHeading').textContent = heading;
  $('genErrDetail').textContent = message;
  $('genTitle').textContent = '没能生成投影';
  playFailure();
}

async function runGeneration() {
  if (!state.midiPath) {
    showGenerateError('还没有选择 MIDI 文件。', '缺少输入');
    return;
  }
  if (!state.outputDir || !state.outputDirToken) {
    showGenerateError('还没有选择保存位置。', '缺少输出位置');
    return;
  }

  $('genErrorBox').style.display = 'none';
  $('genRunningBox').style.display = 'flex';
  $('genTitle').textContent = '正在生成投影';
  startElapsed();

  try {
    // With a destination granted the main process also writes the file. The token is
    // authorization for the chosen folder; the renderer never sends the full path.
    const result = await api.generate(state.midiPath, generateOptions(), {
      token: state.outputDirToken,
      fileName: outputFileName(),
    });
    clearInterval(elapsedTimer);

    if (!result.success) {
      showGenerateError(result.error || '生成器没有给出原因。');
      return;
    }

    state.result = result;
    showResult(result);
    setupPreviewButton();
    goStep(8);
    playSuccess();
  } catch (error) {
    showGenerateError(error?.message || String(error));
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 7: result
 * ──────────────────────────────────────────────────────────────────────────── */

function showResult(result) {
  const stats = result.stats;
  const blocks = stats.noteBlockCount + stats.circuitBlocks + (stats.commandBlockCount ?? 0);
  const size = unionSize(result.regions);

  $('doneFileSub').textContent = result.outputPath
    ? result.outputPath.split(/[\\/]/).pop()
    : `${(result.song?.name || 'Musicbox').replace(/\.(mid|midi)$/i, '')}.litematic（未保存）`;

  $('doneBlocks').textContent = `${number(blocks)} 块`;
  $('doneDims').textContent = size ? `${number(size.x)} × ${number(size.y)} × ${number(size.z)}` : '—';
  $('doneSize').textContent = bytesText(result.bytes);

  $('doneTriggerHint').textContent =
    result.playbackMode === 'command'
      ? '粘贴后结构自带信号源，确认命令方块已开启即可播放'
      : '在主线起点接上红石线，再接一个按钮来驱动';

  $('doneWarningBox').style.display = 'none';
  $('doneWarningBox').textContent = '';

  const notes = [];
  if (result.outOfRangeNotes > 0) notes.push(`${result.outOfRangeNotes} 个音符超出乐器音域`);
  if (result.rangeShift?.notes > 0) {
    notes.push(`其中 ${result.rangeShift.notes} 个被移调，最多移动 ${result.rangeShift.maxSemitones} 个半音`);
  }
  const otherWarnings = result.warnings.filter((warning) => warning.code !== 'OUT_OF_RANGE');
  if (otherWarnings.length > 0) notes.push(`${otherWarnings.length} 条乐器/排布提示`);

  if (notes.length > 0) {
    $('doneWarningBox').style.display = 'block';
    $('doneWarningBox').textContent = `${notes.join('；')}。展开「查看红石布线」或「乐器分配」可以看到细节。`;
  }

  renderAssignmentTable('doneAssignments', result);
  $('doneAssignments').style.display = 'flex';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Wire the controls
 * ──────────────────────────────────────────────────────────────────────────── */

document.addEventListener('click', (event) => {
  const target = event.target;
  const goto = target.closest('[data-goto]');
  if (goto) {
    goStep(goto.getAttribute('data-goto'));
    return;
  }

  const node = target.closest('[data-target]');
  if (node) {
    goStep(node.getAttribute('data-target'));
    return;
  }

  const track = target.closest('[data-track-idx]');
  if (track) {
    const index = Number(track.getAttribute('data-track-idx'));
    const entry = state.tracks[index];
    if (entry) {
      entry.checked = !entry.checked;
      renderTracks(index);
      playNote(entry.checked ? 440 : 260, 'sine', 0.08);
    }
    return;
  }

  const fold = target.closest('[data-fold]');
  if (fold) {
    toggleFoldCard(fold.getAttribute('data-fold'));
    playNote(380, 'sine', 0.06);
    return;
  }

  const option = target.closest('[data-cfg-group]');
  if (option) {
    const group = option.getAttribute('data-cfg-group');
    const value = option.getAttribute('data-cfg-val');
    document
      .querySelectorAll(`[data-cfg-group="${group}"]`)
      .forEach((box) => box.classList.toggle('selected', box === option));

    const previous =
      group === 'instrument'
        ? state.instrumentMode
        : group === 'merge'
          ? state.merge
          : group === 'range'
            ? state.outOfRange
            : state.backend;
    if (group === 'instrument') state.instrumentMode = value;
    if (group === 'range') state.outOfRange = value;
    if (group === 'backend') state.backend = value;
    if (group === 'merge') state.merge = value;
    if (previous !== value && (group === 'instrument' || group === 'merge')) {
      // A manual choice wins, and the panel has to say so: a checkbox that still reads
      // "smart" while the generator follows the manual value was the confusing part.
      state.smartSelection = false;
      // The pack only changes samples, so a merge choice says nothing about it; an
      // instrument choice does.
      if (group === 'instrument') state.packRecommended = null;
    }
    syncSummary();
    // The notice invites the user to leave the defaults alone. Once they have not, it has
    // nothing left to say.
    $('configNotice').style.display = 'none';
    playNote(420, 'sine', 0.08);
  }
});

$('btnPrevStep').addEventListener('click', () => {
  if (state.step > 1) goStep(state.step - 1);
});

$('realFileInput').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) void loadMidi(api.pathForFile(file));
});

$('importEmpty').addEventListener('click', () => void chooseMidiFile());

/* ── Step 2: drag and drop ───────────────────────────────────────────────────
 * Electron 32 removed `File.path`, so the renderer cannot read the dropped file
 * itself; the preload turns the File into an absolute path with
 * `webUtils.getPathForFile`. The whole step is a target, not only the empty box,
 * so dropping a replacement while a song is loaded still works.
 */
const dropStep = $('step-2');
const dropArea = $('importEmpty');
let dragDepth = 0;

function carriesFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function setDragHighlight(on) {
  // The empty box is hidden once a song is loaded; the step itself is always visible,
  // so the replacement-drop path gets feedback too.
  dropStep.classList.toggle('dragover', on);
  dropArea.classList.toggle('dragover', on);
}

dropStep.addEventListener('dragenter', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  setDragHighlight(true);
});

dropStep.addEventListener('dragover', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

dropStep.addEventListener('dragleave', () => {
  if (dragDepth === 0) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragHighlight(false);
});

dropStep.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  setDragHighlight(false);
  const file = event.dataTransfer.files?.[0];
  if (!file) return;
  if (!/\.(mid|midi)$/i.test(file.name)) {
    showImportError('请拖入 .mid 或 .midi 文件。');
    return;
  }
  try {
    const path = api.pathForFile(file);
    if (!path) {
      showImportError('无法读取拖入文件的路径，请改用点击选择。');
      return;
    }
    void loadMidi(path);
  } catch {
    showImportError('无法读取拖入文件的路径，请改用点击选择。');
  }
});

// Without these, Chromium treats a drop outside the target as a navigation and
// replaces the app window with the dropped file.
window.addEventListener('dragover', (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
window.addEventListener('drop', (event) => event.preventDefault());
$('btnChangeFile').addEventListener('click', () => void chooseMidiFile());
$('btnResetImport').addEventListener('click', () => setImportView('empty'));

$('btnToggleAllTracks').addEventListener('click', () => {
  const allChecked = state.tracks.every((track) => track.checked);
  state.tracks.forEach((track) => {
    track.checked = !allChecked;
  });
  renderTracks();
  playNote(allChecked ? 220 : 520, 'sine', 0.1);
});

$('btnSmartApply').addEventListener('click', () => {
  playNote(520, 'sine', 0.07);
  void applySmartSelection();
});

/** A layout switch is a manual choice, exactly like one of the merge boxes. */
function markLayoutManual() {
  state.smartSelection = false;
  const notice = $('configNotice');
  if (notice) notice.style.display = 'none';
  syncSummary();
}

$('btnLaneSharing').addEventListener('click', () => {
  if (state.backend === 'command') return;
  state.laneSharing = !state.laneSharing;
  markLayoutManual();
  playNote(state.laneSharing ? 520 : 300, 'sine', 0.07);
});

$('laneShareSparse').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  state.laneShareSparseBelow = Number.isFinite(value) ? Math.max(1, Math.min(500, Math.round(value))) : 50;
  event.target.value = String(state.laneShareSparseBelow);
  markLayoutManual();
});

$('btnCenterLead').addEventListener('click', () => {
  if (state.backend === 'command') return;
  state.centerLead = !state.centerLead;
  markLayoutManual();
  playNote(state.centerLead ? 500 : 320, 'sine', 0.07);
});

$('btnAnnotateLanes').addEventListener('click', () => {
  if (state.backend === 'command') return;
  state.annotateLanes = !state.annotateLanes;
  // The signs never change the circuit, so this must not push smart routing into manual.
  syncSummary();
  playNote(state.annotateLanes ? 540 : 300, 'sine', 0.06);
});

$('btnLaneRide').addEventListener('click', () => {
  if (state.backend === 'command') return;
  state.laneRide = !state.laneRide;
  // Borrowed power rewrites the circuit, so the recommendation no longer describes it.
  markLayoutManual();
  playNote(state.laneRide ? 560 : 300, 'sine', 0.07);
});

$('leadTrackSelect').addEventListener('change', (event) => {
  const index = Number(event.target.value);
  if (!Number.isSafeInteger(index)) return;
  state.leadTrackIndex = index;
  state.leadBasis = 'manual';
  syncLeadPicker();
  // Picking a lead is not a rejection of the instrument mode or the merge the recommendation
  // chose, so smart selection stays on; the lead card and the check page both say "手动指定".
  // The signature changes, so entering the next step measures again with this lead.
  playNote(460, 'sine', 0.07);
});

$('dMaxInput').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  state.dMax = Number.isFinite(value) ? Math.max(1, Math.min(14, Math.round(value))) : 14;
  event.target.value = String(state.dMax);
  syncSummary();
});

$('commandBudgetInput').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  state.commandBudget = Number.isFinite(value) && value > 0 ? Math.round(value) : 65536;
  event.target.value = String(state.commandBudget);
});

$('btnSavePack').addEventListener('click', async () => {
  try {
    const target = await savePack();
    if (!target) return; // Cancelled.
    notify('资源包已保存，把它放进 .minecraft/resourcepacks/ 再在游戏里启用');
    // Reveal it: finding the file afterwards is the awkward part of this feature.
    await api.reveal(target);
  } catch (error) {
    notify(`保存资源包失败：${error?.message || error}`);
  }
});

$('btnChooseOutput').addEventListener('click', () => void chooseOutputFile());
$('fileNameInput').addEventListener('input', syncOutputText);
$('btnStartGen').addEventListener('click', () => {
  goStep(6);
  void runCheck();
});

// The check step's button is the only thing that writes a file.
$('btnGoGenerate').addEventListener('click', () => {
  goStep(7);
  void runGeneration();
});
$('btnBackToExport').addEventListener('click', () => goStep(5));
$('btnRetryGen').addEventListener('click', () => void runGeneration());

$('btnOpenFolder').addEventListener('click', () => {
  if (state.result?.outputPath) void api.reveal(state.result.outputPath);
  else notify('这份投影还没有保存到文件');
});

$('btnNextSong').addEventListener('click', () => {
  state.midiPath = null;
  state.song = null;
  state.tracks = [];
  state.outputDir = null;
  state.outputDirToken = null;
  state.result = null;
  $('fileNameInput').value = '';
  setImportView('empty');
  syncOutputText();
  goStep(2);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Window controls and settings
 * ──────────────────────────────────────────────────────────────────────────── */

$('btnWinMin').addEventListener('click', () => void api.windowControl('minimize'));
$('btnWinMax').addEventListener('click', () => void api.windowControl('maximize'));
$('btnWinClose').addEventListener('click', () => void api.windowControl('close'));

/** Fill the About rows once, the first time the settings dialog is opened. */
let aboutLoaded = false;
async function loadAbout() {
  if (aboutLoaded) return;
  aboutLoaded = true;
  try {
    const info = await api.appInfo();
    $('aboutVersion').textContent = info.version;
    $('aboutLicense').textContent = info.license;
    $('aboutAuthor').textContent = info.author;
    $('btnOpenRepo').addEventListener('click', () => void api.open(info.repository));
  } catch (error) {
    notify(`无法读取版本信息：${error?.message || error}`);
  }
}

$('btnOpenSettings').addEventListener('click', () => {
  void loadAbout();
  $('settingsModal').classList.add('open');
});
$('btnCloseSettings').addEventListener('click', () => {
  $('settingsModal').classList.remove('open');
});
$('settingsModal').addEventListener('click', (event) => {
  if (event.target === $('settingsModal')) $('settingsModal').classList.remove('open');
});

$('btnDevMode').addEventListener('click', () => {
  setDevMode(!isDevMode(), { openPanel: true });
});

$('btnToggleSound').addEventListener('click', () => {
  state.sound = !state.sound;
  $('btnToggleSound').textContent = state.sound ? '音效开' : '音效关';
  if (state.sound) playNote(587, 'sine', 0.1);
});

$('authorInput').addEventListener('input', (event) => {
  state.author = event.target.value;
  syncSummary();
});

$('baseTpsInput').addEventListener('change', (event) => {
  const value = Number(event.target.value);
  state.baseTps = Number.isFinite(value) ? Math.max(1, Math.min(100, Math.round(value))) : 20;
  event.target.value = String(state.baseTps);
  syncSummary();
});

/** Send the result step's preview button back to the check step, where the wiring view lives. */
function setupPreviewButton() {
  const button = $('btnPreview');
  button.disabled = false;
  button.title = '回到检查结果，查看红石布线';
  button.onclick = () => goStep(6);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The check step: what went wrong, and where
 * ──────────────────────────────────────────────────────────────────────────── */

/** One issue: a heading, the explanation the text module builds, and a way to go and look. */
function issueElement(result, warning) {
  const item = document.createElement('div');
  item.className = 'issue';
  item.dataset.severity = warnSeverity(warning.code);

  const body = document.createElement('div');
  body.className = 'issue-body';

  const title = document.createElement('div');
  title.className = 'issue-title';
  title.textContent = warningTitle(warning.code);

  const detail = document.createElement('div');
  detail.className = 'issue-detail';
  detail.textContent = warningText(result, warning);
  body.append(title, detail);

  const cell = locateWarning(result, warning);
  if (cell) {
    const actions = document.createElement('div');
    actions.className = 'issue-actions';
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'pill-tag';
    jump.textContent = `在红石布线里定位 X${cell.x} · Z${cell.z}`;
    jump.addEventListener('click', () => {
      focusPreviewCell(cell.x, cell.z);
      $('canvasWrap').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    actions.append(jump);
    body.append(actions);
  }

  item.append(body);
  return item;
}

/** How many issues one group shows before it offers to show more. */
const ISSUE_PAGE = 4;

/**
 * Tell the reader there is more below when the next-step button is out of view.
 *
 * A short window puts the action bar below the fold, and a step that ends in visible
 * whitespace reads as a dead end rather than as something to scroll. The observer is rooted
 * at the step itself, so the hint cannot appear while another step is on screen.
 */
function wireScrollHint() {
  const screen = document.getElementById('step-6');
  const button = document.getElementById('btnGoGenerate');
  const hint = document.getElementById('scrollHint');
  if (!screen || !button || !hint || typeof IntersectionObserver === 'undefined') return;

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (entry) hint.hidden = entry.isIntersecting;
    },
    // Half is enough: at 0.85 a button whose top edge was a few pixels below the fold still
    // counted as hidden, so the hint stayed up while the button was plainly visible.
    { root: screen, threshold: 0.5 },
  );
  observer.observe(button);
}
wireScrollHint();

/** Group headings, in the order they are shown. */
const ISSUE_GROUPS = [
  { severity: 'warn', title: '需要处理的' },
  { severity: 'info', title: '仅供了解' },
];

/**
 * Append one page of a group, and a button for the next page while any remain.
 *
 * Rebuilt from the index each time rather than tracked with a cursor, because a group can
 * be hundreds long and the button has to disappear exactly when the last page is shown.
 */
function appendIssuePage(result, container, items, from) {
  const page = items.slice(from, from + ISSUE_PAGE);
  for (const warning of page) container.append(issueElement(result, warning));

  const next = from + ISSUE_PAGE;
  if (next >= items.length) return;

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'btn-glass';
  more.style.alignSelf = 'flex-start';
  more.textContent = `继续加载（还有 ${number(items.length - next)} 条）`;
  more.addEventListener('click', () => {
    more.remove();
    appendIssuePage(result, container, items, next);
  });
  container.append(more);
}

/**
 * Which sparse track ended up on which lane, in the words the user sees.
 *
 * The plan is reported twice - inside the smart summary and on its own field - because the
 * switch also works with smart routing off, and the check step must explain the borrows in
 * both cases.
 */
function laneSharingLines(sharing) {
  const label = (index) => `轨${index + 1}`;
  const byHost = new Map();
  for (const { guest, host } of sharing.borrowed) {
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(guest);
  }
  const lines = [];
  for (const [host, guests] of byHost) {
    lines.push(`借道：${guests.map(label).join('、')} → ${label(host)}`);
  }
  if (sharing.collector.length >= 2) {
    lines.push(`借道：${sharing.collector.map(label).join('、')} 合成一条收集轨`);
  }
  if (sharing.kept.length > 0) {
    lines.push(`借道：${sharing.kept.map(label).join('、')} 装不下，保持独立轨道`);
  }
  return lines;
}

function renderSmartResult(result) {
  const panel = $('smartResult');
  const smart = result.smartSelection;
  if (!smart) {
    panel.style.display = 'none';
    $('smartResultDetail').textContent = '';
    return;
  }

  const category = {
    'pure-harp': '纯竖琴曲',
    'single-instrument': '单乐器曲',
    'multi-instrument': '多乐器多音轨曲',
  }[smart.category];
  const mode = smart.instrumentMode === 'extended' ? '扩展竖琴音域（需资源包）' : '原版乐器';
  const mergeLabel = MERGE_MODE_TEXT;
  const lead = state.tracks.find((track) => track.index === smart.leadTrackIndex);
  const leadBasis =
    {
      manual: '手动指定',
      velocity: '平均 MIDI 力度最高',
      balance: '力度接近，综合活跃度与单音旋律',
      fallback: '没有可用有音律轨，使用当前音轨',
    }[smart.leadBasis] || '自动推荐';
  // A forced merge leaves one spine, so naming a lead track would point at a lane that no
  // longer exists on its own; the sign in the schematic says the same thing.
  const singleLane = result.laneAnnotation?.singleLane ?? smart.mergeMode === 'force';
  const leadLine = singleLane
    ? '主音轨：全曲合并成一条主线，没有独立主音轨（站到主线那一行）'
    : `主音轨：${lead ? `轨 ${lead.index + 1}「${lead.name || lead.instrument}」` : '未指定'} · ${leadBasis}`;

  const lines = [`分类：${category}`, `乐器模式：${mode}`];
  if (result.playbackMode === 'command') {
    // Command playback has no lanes, no Z span and no merge, so none of those conclusions
    // apply; printing a lead track there would suggest a layout that does not exist.
    lines.push('主音轨 / 听距 / 合并方式：命令播放不适用');
  } else {
    lines.push(
      `听距：最远的音符离你 ${smart.radiusZ} 格（阈值 ${smart.compactRadius} / ${smart.audibleRadius} 格）`,
      `合并方式：${mergeLabel[smart.mergeMode] ?? smart.mergeMode}`,
      leadLine,
      `资源包：${smart.resourcePackRecommended ? '建议保存（需自行安装，不会自动装）' : '不需要'}`,
    );
    const sharing = result.laneSharing ?? smart.laneSharing;
    if (sharing) lines.push(...laneSharingLines(sharing));
    const ride = result.laneRide;
    if (ride && ride.count > 0) {
      const shown = ride.lanes
        .slice(0, 6)
        .map((lane) => `${lane.z}←${lane.hostZ}`)
        .join('、');
      const more = ride.count > 6 ? ` 等 ${ride.count} 条` : '';
      const longest = Math.max(...ride.lanes.map((lane) => lane.rows ?? 1));
      lines.push(
        `轨道取电：${ride.count} 条轨道从相邻轨道取电（Z ${shown}${more}），最长跨 ${longest} 行，每行多 1 红石 tick 已计入`,
      );
    }
    const candidates = smart.candidates
      .map((candidate) => `${mergeLabel[candidate.mode] ?? candidate.mode} 最远 ${candidate.radiusZ} 格`)
      .join(' · ');
    if (candidates) lines.push(`候选布局：${candidates}`);
    const annotation = result.laneAnnotation;
    if (annotation) {
      const spot = `(${annotation.player.x}, ${annotation.player.y}, ${annotation.player.z})`;
      lines.push(`投影注释：${annotation.signs.length} 条牌 · 站 ${spot} · 听距 ${annotation.spreadZ} 格`);
    }
  }

  $('smartResultDetail').textContent = lines.join('\n');
  panel.style.display = 'flex';
}

function renderIssues(result) {
  const list = $('issueList');
  list.replaceChildren();

  const warnings = (result.warnings ?? []).slice(0, WARNING_DISPLAY_LIMIT);
  const bySeverity = new Map(ISSUE_GROUPS.map((group) => [group.severity, []]));
  for (const warning of warnings) {
    const severity = warnSeverity(warning.code) === 'warn' ? 'warn' : 'info';
    bySeverity.get(severity).push(warning);
  }

  if (warnings.length === 0) {
    $('checkSummary').textContent = '没有发现问题，可以直接生成。';
    return;
  }

  const actionable = bySeverity.get('warn').length;
  $('checkSummary').textContent =
    actionable > 0
      ? `共 ${number(warnings.length)} 条，其中 ${number(actionable)} 条建议处理。` +
        '点「在红石布线里定位」可以跳到对应位置；想改配置就点「上一步」。'
      : `共 ${number(warnings.length)} 条，都不影响生成，看一眼即可。`;

  for (const group of ISSUE_GROUPS) {
    const items = bySeverity.get(group.severity);
    if (items.length === 0) continue;

    const heading = document.createElement('div');
    heading.className = 'issue-group';
    heading.dataset.severity = group.severity;
    heading.textContent = `${group.title} · ${number(items.length)} 条`;
    list.append(heading);

    const body = document.createElement('div');
    body.className = 'issue-list';
    list.append(body);
    appendIssuePage(result, body, items, 0);
  }
}

/**
 * A chip per track, so the user can reach a row instead of hunting for it by dragging.
 *
 * The Z position comes from the regions the generator reported rather than from the track
 * index, because the spacing between tracks depends on how wide the song's chords are.
 */
function renderTrackChips(result) {
  const box = $('previewTrackChips');
  box.replaceChildren();

  const firstRowOfTrack = new Map();
  for (const region of result.regions ?? []) {
    if (!firstRowOfTrack.has(region.trackIndex)) {
      firstRowOfTrack.set(region.trackIndex, region.position.z);
    }
  }

  for (const [index, z] of firstRowOfTrack) {
    const track = (result.tracks ?? []).find((entry) => entry.index === index);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pill-tag';
    chip.textContent =
      index < 0 ? '合并主线' : track?.name ? `${index + 1} ${track.name}` : `音轨 ${index + 1}`;
    chip.title = `跳到 z${z} 行`;
    chip.addEventListener('click', () => focusPreviewCell(0, z));
    box.append(chip);
  }
}

/**
 * What each source track became: native instrument, effective instrument, octave shift
 * and why. This is reference rather than a warning, so it gets its own fold.
 */
function renderAssignmentTable(containerId, result) {
  const box = $(containerId);
  box.replaceChildren();
  const rows = result.trackInstruments ?? [];

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'assignment-empty';
    empty.textContent = '没有可显示的乐器分配。';
    box.append(empty);
    return;
  }

  const head = document.createElement('div');
  head.className = 'assignment-row head';
  for (const label of ['轨', '乐器', '八度', '说明']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    head.append(cell);
  }
  box.append(head);

  const nameOf = (id) => (id === 'drums' ? '打击乐' : id === 'piano' ? '钢琴扩展' : instrumentName(id));

  // Which source track shares a lane, and with whom. Absent whenever nothing shares.
  const sharing = result.laneSharing ?? result.smartSelection?.laneSharing;
  const hostOfGuest = new Map();
  const guestsOfHost = new Map();
  for (const { guest, host } of sharing?.borrowed ?? []) {
    hostOfGuest.set(guest, host);
    if (!guestsOfHost.has(host)) guestsOfHost.set(host, []);
    guestsOfHost.get(host).push(guest);
  }
  const collectors = new Set(sharing?.collector ?? []);

  for (const info of rows) {
    const track = (result.tracks ?? []).find((entry) => entry.index === info.trackIndex);
    const native = nameOf(info.native);
    const effective = nameOf(info.effective);
    const instrumentText = info.substituted ? `${native} → ${effective}` : effective;
    const octave = info.octaveOffset === 0 ? '—' : `${info.octaveOffset > 0 ? '+' : ''}${info.octaveOffset}`;
    const notes = [];
    if (info.source === 'fallback') notes.push('未识别，按竖琴');
    if (info.substituted) notes.push('扩展模式替代');
    if (info.octaveOffset !== 0) notes.push(`整轨${info.octaveOffset > 0 ? '升' : '降'}八度`);
    if (info.outsideNotes > 0) notes.push(`${info.outsideNotes} 个音单独移调`);
    if (info.effective === 'drums') notes.push('鼓通道按音符映射');
    if (hostOfGuest.has(info.trackIndex)) notes.push(`借轨到轨${hostOfGuest.get(info.trackIndex) + 1}`);
    const guests = guestsOfHost.get(info.trackIndex);
    if (guests) notes.push(`收拢轨${guests.map((index) => index + 1).join('、')}`);
    if (collectors.has(info.trackIndex)) notes.push('合成收集轨');
    if (notes.length === 0) notes.push('原版音色');

    const row = document.createElement('div');
    row.className = 'assignment-row';
    for (const text of [
      `轨${info.trackIndex + 1}`,
      instrumentText,
      octave,
      `${notes.join('；')}${track?.name ? ` · ${track.name}` : ''}`,
    ]) {
      const cell = document.createElement('span');
      cell.textContent = text;
      row.append(cell);
    }
    box.append(row);
  }

  const substituted = rows.filter((row) => row.substituted).length;
  const shifted = rows.filter((row) => row.octaveOffset !== 0).length;
  const shared = (sharing?.borrowed.length ?? 0) + (collectors.size >= 2 ? collectors.size : 0);
  $('sumAssignments').textContent =
    `${rows.length} 条轨` +
    (substituted > 0 ? ` · ${substituted} 条替代` : '') +
    (shifted > 0 ? ` · ${shifted} 条移八度` : '') +
    (shared > 0 ? ` · 借道 ${shared} 条` : '') +
    ' · 点开看详情';
}

/**
 * Run a generation for its warnings alone.
 *
 * The output path is deliberately left out: the main process then builds the whole result
 * and writes no file, which is what makes this a rehearsal rather than an export.
 */
async function runCheck() {
  if (!state.midiPath) return;
  $('checkSummary').textContent = '正在先跑一遍，看看有什么问题…';
  $('issueList').replaceChildren();

  try {
    const result = await api.generate(state.midiPath, generateOptions());
    if (!result.success) {
      $('smartResult').style.display = 'none';
      $('checkSummary').textContent = '这一遍没能跑完。';
      const item = document.createElement('div');
      item.className = 'issue';
      item.dataset.severity = 'error';
      const body = document.createElement('div');
      body.className = 'issue-body';
      const title = document.createElement('div');
      title.className = 'issue-title';
      title.textContent = '生成失败';
      const detail = document.createElement('div');
      detail.className = 'issue-detail';
      detail.textContent = result.error || '生成器没有给出原因。';
      body.append(title, detail);
      item.append(body);
      $('issueList').append(item);
      playFailure();
      return;
    }

    const issues = result.warnings?.length ?? 0;
    $('checkSummary').textContent =
      issues === 0
        ? '没有发现问题，可以直接生成。'
        : `共 ${number(issues)} 处需要看一眼。点「在红石布线里定位」可以跳到对应位置；想改配置就点「上一步」。`;
    renderIssues(result);
    renderSmartResult(result);
    renderTrackChips(result);
    renderAssignmentTable('assignmentTable', result);
    // The canvas measures its container, so this runs after the step is on screen.
    renderPreview(result);
    if (issues === 0) notify('没有发现问题，可以生成');
  } catch (error) {
    $('checkSummary').textContent = '这一遍没能跑完。';
    notify(`检查失败：${error?.message || error}`);
    playFailure();
  }
}

// Panning and the layer toggles. The drawing module exposes the operations but binds
// nothing itself, so the controls live here.
for (const id of ['showGrid', 'showNotes']) {
  $(id).addEventListener('change', () => {
    if (state.result) renderPreview(state.result);
  });
}

(() => {
  const wrap = $('canvasWrap');
  let dragging = null;
  wrap.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, z: event.clientY };
    wrap.setPointerCapture(event.pointerId);
  });
  // Panning redraws the whole schematic, which on a long song takes longer than the gap
  // between pointer events. Redrawing on every event therefore fell behind the cursor: the
  // drawing moved a fraction of the distance dragged, and the lost deltas made a diagonal
  // drag look like it was only following one axis. Accumulate and draw once per frame.
  let pending = null;
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (!pending) return;
    panPreview(pending.x, pending.z);
    pending = null;
  };
  wrap.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    // Moving the mouse right should move the drawing right, hence the negative delta.
    const dx = dragging.x - event.clientX;
    const dz = dragging.z - event.clientY;
    dragging = { x: event.clientX, z: event.clientY };
    pending = { x: (pending?.x ?? 0) + dx, z: (pending?.z ?? 0) + dz };
    if (!frame) frame = requestAnimationFrame(flush);
  });
  const stop = () => {
    dragging = null;
  };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);

  // The wheel scrolls the drawing sideways, which is the useful axis now that there is no
  // zoom to spend it on and songs are long rather than tall. A horizontal wheel, or a
  // trackpad's two-finger swipe, arrives as deltaX and is used as it comes.
  wrap.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      panPreview(event.deltaX !== 0 ? event.deltaX : event.deltaY, 0);
    },
    { passive: false },
  );
})();

/* ────────────────────────────────────────────────────────────────────────────
 * The position indicator under the canvas
 * ──────────────────────────────────────────────────────────────────────────── */

/** Redraw the thumb from the view the drawing module reports. */
function syncPreviewScroll() {
  const track = $('previewScroll');
  const thumb = $('previewThumb');
  const position = previewPosition();
  if (!position) {
    track.hidden = true;
    return;
  }

  track.hidden = false;
  const width = Math.max(24, track.clientWidth * Math.min(1, position.columns / position.total));
  const travel = Math.max(0, track.clientWidth - width);
  const offset =
    position.total > position.columns ? (position.x0 / (position.total - position.columns)) * travel : 0;
  thumb.style.width = width + 'px';
  thumb.style.left = Math.max(0, Math.min(travel, offset)) + 'px';
}

/** Put the view where a click or drag on the track points. */
function seekPreview(clientX) {
  const track = $('previewScroll');
  const position = previewPosition();
  if (!position) return;
  const box = track.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
  const target = fraction * Math.max(0, position.total - position.columns);
  panPreview((target - position.x0) * position.cell, 0);
}

document.addEventListener('preview:drawn', syncPreviewScroll);
window.addEventListener('resize', syncPreviewScroll);

(() => {
  const track = $('previewScroll');
  let dragging = false;
  track.addEventListener('pointerdown', (event) => {
    dragging = true;
    track.dataset.dragging = 'true';
    track.setPointerCapture(event.pointerId);
    seekPreview(event.clientX);
  });
  track.addEventListener('pointermove', (event) => {
    if (dragging) seekPreview(event.clientX);
  });
  const stop = () => {
    dragging = false;
    delete track.dataset.dragging;
  };
  track.addEventListener('pointerup', stop);
  track.addEventListener('pointercancel', stop);
})();

/* ────────────────────────────────────────────────────────────────────────────
 * Developer mode
 *
 * The panel shows what the flow consumed, not a second opinion: the state, the routing
 * measurement, the last result and every IPC call. Actions call the same functions the
 * steps call, so testing through the panel exercises the real path.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Everything the diagnostics drawer shows; each tab slices one key. */
function devSnapshot() {
  return {
    state: {
      step: state.step,
      midiPath: state.midiPath,
      song: state.song,
      lead: { trackIndex: state.leadTrackIndex, basis: state.leadBasis },
      smart: {
        applied: state.smartSelection,
        measured: state.smartMeasured,
        signature: state.smartSignature,
        packRecommended: state.packRecommended,
      },
      options: state.midiPath ? generateOptions() : null,
      output: { dir: state.outputDir, hasToken: Boolean(state.outputDirToken) },
      measure: state.devMeasure,
    },
    tracks: state.tracks.map((track) => ({
      index: track.index,
      name: track.name,
      instrument: track.instrument,
      detected: track.detectedInstrument,
      detectionSource: track.detectionSource,
      percussion: track.percussion,
      checked: track.checked,
      notes: track.noteCount,
      meanVelocity: Number(track.meanVelocity.toFixed(3)),
      activeSeconds: Number(track.activeSeconds.toFixed(2)),
      polyphonicOnsetRatio: Number(track.polyphonicOnsetRatio.toFixed(3)),
      melodicScore: Number(track.melodicScore.toFixed(3)),
      prominenceScore: Number(track.prominenceScore.toFixed(3)),
    })),
    result: devResult(),
  };
}

/** The last generation result, trimmed to what is worth reading in a drawer. */
function devResult() {
  const result = state.result;
  if (!result) return null;
  const warningCounts = {};
  for (const warning of result.warnings ?? []) {
    warningCounts[warning.code] = (warningCounts[warning.code] ?? 0) + 1;
  }
  return {
    success: result.success,
    error: result.error,
    playbackMode: result.playbackMode,
    stats: result.stats,
    pitchRange: result.pitchRange,
    smartSelection: result.smartSelection,
    laneAnnotation: result.laneAnnotation,
    laneRide: result.laneRide,
    rangeShift: result.rangeShift,
    warningCounts,
    warnings: (result.warnings ?? []).slice(0, 40),
    regions: (result.regions ?? []).map((region) => ({
      name: region.name,
      trackIndex: region.trackIndex,
      position: region.position,
      size: region.size,
      blocks: region.blockCount,
    })),
    trackInstruments: result.trackInstruments,
    commandPlayback: result.commandPlayback,
  };
}

let devMeasureTimer = null;
let devMeasureToken = 0;

/**
 * Measure the layout behind the current options, debounced.
 *
 * Changing an option twice in a row should measure once; the readout is a diagnostic, not
 * part of the flow, so it must never slow down the click that caused it.
 */
function scheduleDevMeasure(delay = 320) {
  clearTimeout(devMeasureTimer);
  if (!isDevMode() || !state.midiPath) {
    clearDevMeasure();
    return;
  }
  devMeasureTimer = setTimeout(() => void runDevMeasure(), delay);
}

function clearDevMeasure(message = '') {
  state.devMeasure = null;
  const element = $('devMeasure');
  if (element) element.textContent = message;
}

/** Why the last measurement borrowed no lane; a switch that changes nothing has to say why. */
const SHARE_OUTCOME_TEXT = {
  applied: '借道已应用',
  outranked: '借道未采用（合并后听距更近）',
  'not-narrower': '借道未生效（实测听距没有变近）',
  merged: '借道未生效（已强制合并成一条主线）',
  'no-sparse': '借道未尝试（合并后没有音符很少的轨道）',
  'no-plan': '借道未尝试（没有可借的轨道）',
  disabled: '借道已关闭',
  failed: '借道失败',
};

/** One line: the box, how many Minecraft tracks it needs, and the cost of the song. */
function measureText(measure) {
  const merge = MERGE_MODE_TEXT[measure.mergeMode] ?? measure.mergeMode;
  const parts = [
    `X ${measure.size.x} × Y ${measure.size.y} × Z ${measure.size.z}`,
    `MC 轨道 ${measure.trackCount} 条`,
    `源音轨 ${measure.sourceTrackCount} 条`,
    `站 Z ${measure.playerZ}`,
    `最远 ${measure.hearingRadius} 格`,
    `区域 ${measure.regionCount}`,
    `音符盒 ${number(measure.noteBlockCount)}`,
    `方块 ${number(measure.blockCount)}`,
    `合并 ${merge}`,
  ];
  const shareOutcome = SHARE_OUTCOME_TEXT[measure.shareOutcome];
  if (shareOutcome) {
    parts.push(measure.sharedLanes > 0 ? `${shareOutcome}（${measure.sharedLanes} 组）` : shareOutcome);
  } else if (measure.sharedLanes > 0) {
    parts.push(`借道 ${measure.sharedLanes} 组`);
  }
  // The widths every candidate produced, so a surprising choice can be checked by eye.
  if (Array.isArray(measure.candidates) && measure.candidates.length > 1) {
    const widths = measure.candidates.map((c) => `${MERGE_MODE_TEXT[c.mode] ?? c.mode} ${c.radiusZ}`);
    parts.push(`候选 ${widths.join(' / ')}`);
  }
  if (measure.riddenLanes > 0) {
    parts.push(`取电 ${measure.riddenLanes} 条`);
  }
  if (measure.annotatedSigns > 0) {
    parts.push(`注释 ${measure.annotatedSigns} 牌（+${measure.annotatedExtraX} X）`);
  }
  parts.push(`${measure.elapsedMs} ms`);
  if (measure.warnings > 0) parts.push(`提示 ${measure.warnings} 条`);
  return parts.join(' · ');
}

async function runDevMeasure() {
  if (!isDevMode() || !state.midiPath) return;
  if (state.backend === 'command') {
    clearDevMeasure('命令播放后端：没有轨道排布，X / Y / Z 与轨道数不适用');
    return;
  }
  const token = ++devMeasureToken;
  const element = $('devMeasure');
  if (element) element.textContent = '测量布局…';
  try {
    const measure = await api.measure(state.midiPath, generateOptions());
    if (token !== devMeasureToken) return;
    state.devMeasure = measure;
    if (element) element.textContent = measureText(measure);
    refreshDev();
  } catch (error) {
    if (token !== devMeasureToken) return;
    clearDevMeasure(`布局测量失败：${error?.message || error}`);
  }
}

window.addEventListener('devmode:changed', () => scheduleDevMeasure(0));

registerDev({ snapshot: devSnapshot, actions: { remeasure: applySmartSelection, check: runCheck } });
initDevMode(api);

// A renderer failure is exactly what this mode exists to make visible.
window.addEventListener('error', (event) => {
  devLog('error', { where: 'renderer', message: event.message, source: event.filename, line: event.lineno });
});
window.addEventListener('unhandledrejection', (event) => {
  devLog('error', { where: 'renderer', message: event.reason?.message || String(event.reason) });
});

/** Logs from the main process (uncaught exceptions) still deserve to be visible. */
api.onLog((line) => {
  notify(line);
  devLog('main', line);
});

setImportView('empty');
syncSummary();
syncOutputText();
goStep(1);
