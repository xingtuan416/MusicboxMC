/**
 * The renderer's whole behaviour: a seven-step flow wired to the main process.
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

import { maybePromptForPack, savePack } from './resourcepack.js';
import { focusPreviewCell, panPreview, renderPreview } from './preview.js';
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
  outputPath: null,
  /** The rehearsal result, used by the check step. Never the exported one. */
  checkResult: null,
  result: null,
  palette: 'full',
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
  // shown once, and only for an export that actually wrote a full-range file.
  if (next === 8 && state.result?.outputPath) {
    maybePromptForPack(state.palette === 'full');
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

function renderTracks() {
  const box = $('trackListBox');
  box.replaceChildren();

  state.tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = `track-item ${track.checked ? 'checked' : 'unchecked'}`;
    row.dataset.trackIdx = String(index);

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

    text.append(name, meta);
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
  $('sumPitch').textContent =
    state.palette === 'full'
      ? `全音域 F#1–F#7 · 最多 ${state.dMax} 音同时`
      : `钢琴音域 F#3–F#5 · 最多 ${state.dMax} 音同时`;
  $('sumRange').textContent = {
    warn: '提示并八度移调',
    octave: '自动八度移调',
    clamp: '改用最近可用音',
    drop: '跳过这些音符',
  }[state.outOfRange];
  $('sumBackend').textContent = state.backend === 'command' ? '命令方块播放' : '红石电路';
  $('commandBudgetField').style.display = state.backend === 'command' ? 'flex' : 'none';
}

/** Map the interface state onto the generator's options, and nothing more. */
function generateOptions() {
  const chosen = state.tracks.filter((track) => track.checked);
  const options = {
    baseTps: state.baseTps,
    dMax: state.dMax,
    outOfRange: state.outOfRange,
    extendedRange: state.palette === 'full',
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
  const name = $('fileNameInput').value.trim();
  $('fullPathText').textContent = state.outputPath
    ? `完整路径：${state.outputPath}`
    : `完整路径：${name || '尚未选择'}（保存时确定目录）`;
  $('outputDirText').textContent = state.outputPath
    ? state.outputPath.replace(/[\\/][^\\/]*$/, '')
    : '尚未选择，生成时会弹出系统保存对话框';

  // Writing a schematic is what this step is for, so it stays disabled until there is
  // somewhere to write it. `runGeneration` checks the same thing, because a disabled
  // button is a hint and not a guarantee.
  $('btnStartGen').disabled = !state.outputPath;
}

async function chooseOutputFile() {
  const name = $('fileNameInput').value.trim() || suggestedName(state.midiPath, state.song?.name);
  try {
    const path = await api.chooseOutput(name);
    if (!path) return;
    state.outputPath = path;
    const leaf = path.split(/[\\/]/).pop();
    if (leaf) $('fileNameInput').value = leaf;
    syncOutputText();
    playNote(480, 'sine', 0.08);
  } catch (error) {
    notify(`无法选择保存位置：${error?.message || error}`);
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
  if (!state.outputPath) {
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
    const result = await api.generate(state.midiPath, generateOptions(), state.outputPath ?? undefined);
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
  if (result.outOfRangeNotes > 0) notes.push(`${result.outOfRangeNotes} 个音符超出电路音域`);
  if (result.rangeShift?.notes > 0) {
    notes.push(`其中 ${result.rangeShift.notes} 个被移调，最多移动 ${result.rangeShift.maxSemitones} 个半音`);
  }
  const otherWarnings = result.warnings.filter((warning) => warning.code !== 'OUT_OF_RANGE');
  if (otherWarnings.length > 0) notes.push(`${otherWarnings.length} 条排布提示`);

  if (notes.length > 0) {
    $('doneWarningBox').style.display = 'block';
    $('doneWarningBox').textContent = `${notes.join('；')}。展开「查看红石布线」可以看到它们的位置。`;
  }
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
      renderTracks();
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

    if (group === 'palette') state.palette = value;
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
  state.outputPath = null;
  state.checkResult = null;
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

$('btnOpenSettings').addEventListener('click', () => {
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
});

/**
 * The preview canvas is not wired up yet.
 *
 * It needs the container markup and roughly thirty CSS rules that live with the previous
 * renderer, and its modules reach for their own element ids. Until that is ported the
 * button stays disabled and says so, rather than offering a control that cannot work -
 * which is the same class of problem as the placeholder text this pass removed.
 */
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
const ISSUE_PAGE = 50;

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
    chip.textContent = track?.name ? `${index + 1} ${track.name}` : `音轨 ${index + 1}`;
    chip.title = `跳到 z${z} 行`;
    chip.addEventListener('click', () => focusPreviewCell(0, z));
    box.append(chip);
  }
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
    state.checkResult = result;
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
  wrap.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    // Moving the mouse right should move the drawing right, hence the negative delta.
    panPreview(dragging.x - event.clientX, dragging.z - event.clientY);
    dragging = { x: event.clientX, z: event.clientY };
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

/** Logs from the main process (uncaught exceptions) still deserve to be visible. */
api.onLog((line) => notify(line));

setImportView('empty');
syncSummary();
syncOutputText();
goStep(1);
