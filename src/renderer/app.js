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

import { instrumentName } from './instruments.js';
import { maybePromptForPack, savePack } from './resourcepack.js';
import { focusPreviewCell, panPreview, previewPosition, renderPreview } from './preview.js';
import {
  locateWarning,
  WARNING_DISPLAY_LIMIT,
  warnSeverity,
  warningText,
  warningTitle,
} from './warningText.js';

const api = window.musicbox;

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
  /** Folder the schematic will be written into. The file name is kept separately. */
  outputDir: null,
  result: null,
  /** 'extended' keeps the five-slot piano range; 'native' follows every MIDI instrument. */
  instrumentMode: 'extended',
  dMax: 14,
  outOfRange: 'warn',
  backend: 'redstone',
  /** 'off' | 'same' | 'force' - one value, because merge and force-merge conflict. */
  merge: 'off',
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

  // The pack nudge belongs on the last step, not on the check step: arriving at the check
  // step with a modal over it hides the very thing the user was sent there to read. It is
  // shown once, and only for an export that actually wrote an extended-mode file.
  if (next === 8 && state.result?.outputPath) {
    maybePromptForPack(state.instrumentMode === 'extended');
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
    meta.textContent = `${number(track.noteCount)} 个音符`;

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
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 4: configuration
 * ──────────────────────────────────────────────────────────────────────────── */

function syncSummary() {
  const extended = state.instrumentMode === 'extended';
  $('sumPitch').textContent = extended
    ? `扩展竖琴音域 · 钢琴 F#1–F#7 · 最多 ${state.dMax} 音同时`
    : `原版乐器 · 各乐器两个八度 · 最多 ${state.dMax} 音同时`;
  $('packTitle').textContent = extended
    ? '配套资源包（扩展竖琴音域建议安装）'
    : '配套资源包（原版乐器模式不需要）';
  $('packDescription').textContent = extended
    ? '扩展竖琴音域的五种音色（bass、guitar、harp、flute、bell）各有一段钢琴采样；装包后它们听起来像同一架钢琴。'
    : '原版乐器模式每条轨使用自己的音色；装了这个包反而会把原生 bass、guitar、flute、bell 也替换成钢琴，所以不建议安装。';
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
  const tpsText = state.baseTps === 20 ? '' : ` · 基准 ${state.baseTps} TPS`;
  $('sumMisc').textContent = `${mergeText}${tpsText} · 作者 ${state.author.trim() || 'MusicboxMC'}`;
  $('commandBudgetField').style.display = state.backend === 'command' ? 'flex' : 'none';
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
  };
  if (state.author.trim()) options.author = state.author.trim();
  if (state.backend === 'command') options.commandChainBudget = state.commandBudget;
  if (chosen.length === 0) options.excludeTracks = state.tracks.map((track) => track.index);
  return options;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 5: output location
 * ──────────────────────────────────────────────────────────────────────────── */

function syncOutputText() {
  const name = $('fileNameInput').value.trim() || '未命名';
  $('fullPathText').textContent = state.outputDir
    ? `完整路径：${state.outputDir}\\${name}`
    : `完整路径：尚未选择文件夹（文件名 ${name}）`;
  $('outputDirText').textContent = state.outputDir ?? '尚未选择文件夹';

  // Writing a schematic is what this step is for, so it stays disabled until there is
  // somewhere to write it. `runGeneration` checks the same thing, because a disabled
  // button is a hint and not a guarantee.
  $('btnStartGen').disabled = !state.outputDir;
}

async function chooseOutputFile() {
  try {
    const directory = await api.chooseDirectory();
    if (!directory) return; // Cancelled.
    state.outputDir = directory;
    syncOutputText();
    playNote(480, 'sine', 0.08);
  } catch (error) {
    notify(`无法选择文件夹：${error?.message || error}`);
  }
}

/** The full path the schematic will be written to, or null while no folder is chosen. */
function outputPath() {
  if (!state.outputDir) return null;
  const name = $('fileNameInput').value.trim() || suggestedName(state.midiPath, state.song?.name);
  return `${state.outputDir}\\${name}`;
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
  if (!state.outputDir) {
    showGenerateError('还没有选择保存位置。', '缺少输出位置');
    return;
  }

  $('genErrorBox').style.display = 'none';
  $('genRunningBox').style.display = 'flex';
  $('genTitle').textContent = '正在生成投影';
  startElapsed();

  try {
    // With a destination chosen the main process also writes the file; without one it
    // only builds the result, which is what the preview needs.
    const result = await api.generate(state.midiPath, generateOptions(), outputPath() ?? undefined);
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
    document.getElementById(fold.getAttribute('data-fold'))?.classList.toggle('open');
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

    if (group === 'instrument') state.instrumentMode = value;
    if (group === 'range') state.outOfRange = value;
    if (group === 'backend') state.backend = value;
    if (group === 'merge') state.merge = value;
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
  $('sumAssignments').textContent =
    `${rows.length} 条轨` +
    (substituted > 0 ? ` · ${substituted} 条替代` : '') +
    (shifted > 0 ? ` · ${shifted} 条移八度` : '') +
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

/** Logs from the main process (uncaught exceptions) still deserve to be visible. */
api.onLog((line) => notify(line));

setImportView('empty');
syncSummary();
syncOutputText();
goStep(1);
