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
import { savePack, showPackNudge } from './resourcepack.js';
import {
  focusPreviewCell,
  panPreview,
  previewDiagnostics,
  previewPosition,
  renderPreview,
} from './preview.js';
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
  midiRevision: undefined,
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
  /** The options that produced the last recommendation. */
  smartSignature: '',
  /** Bumped per measurement so a slow answer cannot overwrite newer settings. */
  smartToken: 0,
  /** Last layout measurement shown by developer mode on the configuration step. */
  devMeasure: null,
  /** Exact output path and token from the native save dialog. */
  output: null,
  choosingOutput: false,
  /**
   * Remembered between launches by the main process: the folder last written to, and
   * whether the resource-pack reminder was muted for good.
   */
  prefs: { lastOutputDir: null, packPromptMuted: false },
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

/**
 * Remember a choice the main process keeps for the next launch.
 *
 * The patch is applied locally first so the interface reacts even if the write fails; the
 * answer from the main process then replaces it, because it is the copy that will be read
 * on the next start.
 */
async function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  syncPackReminderButton();
  try {
    const { persisted, ...prefs } = await api.setPreferences(patch);
    state.prefs = prefs;
    if (persisted === false) notify('设置已在本次会话生效，重启后可能恢复原值。');
  } catch (error) {
    devLog('prefs', { error: error?.message || String(error) });
  }
  syncPackReminderButton();
}

/** The settings row that holds the reminder choice. */
function syncPackReminderButton() {
  const button = document.getElementById('btnPackReminder');
  if (!button) return;
  button.textContent = state.prefs.packPromptMuted ? '提醒关' : '提醒开';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step navigation
 * ──────────────────────────────────────────────────────────────────────────── */

function goStep(target) {
  const next = Math.max(1, Math.min(steps.length, Number(target)));
  if (next !== state.step && activeJob?.kind === 'export' && activeJob.stage === 'write') return;
  if ((state.step === 6 || state.step === 7) && next !== state.step && activeJob) {
    void cancelJob();
  }
  state.step = next;

  steps.forEach((section, index) => section.classList.toggle('active', index + 1 === next));
  $('btnPrevStep').classList.toggle('is-hidden', next === 1);
  syncJobControls();

  playNote(330 + next * 40, 'sine', 0.08);

  if (next === 4) {
    syncSmartPanel();
    scheduleSmartSelection();
    scheduleDevMeasure(0);
  }

  // The pack nudge belongs on the last step, not on the check step: arriving at the check
  // step with a modal over it hides the very thing the user was sent there to read.
  if (next === 8 && state.result?.outputPath) {
    const packWanted = state.result.resourcePackRecommended ?? state.instrumentMode === 'extended';
    // Shown after every export that needs it, not once per installation: the reminder is
    // only useful to someone who is about to install the pack. "Don't ask again" is the
    // way out, and the setting that holds it can be undone.
    if (packWanted && !state.prefs.packPromptMuted) {
      showPackNudge({
        onMute: () => void savePrefs({ packPromptMuted: true }),
        onSave: () => void saveResourcePack(),
      });
    }
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
  syncJobControls();
}

/**
 * Read the failure the way a musician would, not the way a parser reports it.
 *
 * The main process names the real problem ("Bad MIDI file. Expected 'MHdr', got: …"), which
 * is the wrong sentence to put in front of someone who just picked a file: it states a fact
 * about a header instead of what to do next. The raw text is kept, but folded away - for a
 * corrupt file it carries the byte offset, which is the only way to tell two broken files
 * apart when one does report it.
 */
function describeImportFailure(raw) {
  const text = String(raw ?? '');
  const lower = text.toLowerCase();
  if (/mhdr|mthd|bad midi|not a midi|invalid midi|truncated|unexpected end/.test(lower)) {
    return '这看起来不是 MIDI 乐谱，或者文件没有下载完整。扩展名是 .mid 不代表内容也是——有些工具会把音频直接改名成 .mid。';
  }
  if (lower.includes('smpte')) {
    return '这个文件按秒计时（SMPTE 时间码），目前只支持按拍计时的乐谱。';
  }
  if (/文件不存在|enoent/.test(lower)) {
    return '这个文件已经不在了，可能被移动、重命名或清理掉了。重新选一次试试。';
  }
  if (/eacces|eperm|permission|拒绝访问/.test(lower)) {
    return '系统不允许读取这个文件。把它复制到桌面再导入通常就好了。';
  }
  return '文件读取失败了。如果它来自别的软件，换一个导出设置重新导出一次往往能解决。';
}

function showImportError(message) {
  $('importErrHeading').textContent = '这个文件读不了';
  $('importErrDetail').textContent = describeImportFailure(message);
  $('importErrTech').textContent = String(message ?? '');
  setImportView('error');
  playFailure();
}

let importToken = 0;

async function loadMidi(path) {
  if (!path) return;
  const token = ++importToken;
  state.smartToken++;
  devMeasureToken++;
  void cancelJob();
  setImportView('loading');
  try {
    const result = await api.analyze(path);
    if (token !== importToken) return;
    state.midiPath = result.path ?? path;
    state.midiRevision = result.sourceRevision;
    state.result = null;
    checkedSignature = null;
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

    $('midiFileTitle').textContent = result.file;
    $('valDuration').textContent = result.song.durationText;
    // Tempo comes back as 60000000 / microsecondsPerBeat, so an exact 70 BPM reads as
    // 70.000315… - a rounding artefact of the file format, not information. Nobody sets a
    // song to 70.0003 BPM, and the digit noise makes the number look untrustworthy.
    $('valBpm').textContent = `${Math.round(result.song.baseBpm)} BPM`;
    $('valTracks').textContent = String(state.tracks.length);
    // "MThd passed, standard multi-track sequence" was jargon in a fixed sentence that was
    // also wrong for single-track files. What the reader actually needs is one plain fact.
    $('midiFileSub').textContent = `校验通过 · ${state.tracks.length} 条音轨`;
    $('valNotes').textContent = number(result.song.noteCount);

    state.output = null;

    const dropped = result.tracks.length - state.tracks.length;
    $('trackFilterHint').style.display = dropped > 0 ? 'block' : 'none';
    $('trackFilterHint').textContent =
      dropped > 0 ? `已过滤 ${dropped} 条不含音符的音轨（指挥轨，或从未使用的通道）。` : '';

    renderTracks();
    // The step summary decides which cards apply to this song (a single track hides the lead
    // picker), and importing is not one of the steps that used to refresh it.
    syncSummary();
    syncOutputText();
    setImportView('loaded');
    playNote(660, 'triangle', 0.12);

    if (result.song.noteCount === 0) {
      notify('这个文件里没有音符');
    }
  } catch (error) {
    if (token === importToken) showImportError(error?.message || String(error));
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

/** One line naming the track that was picked, and what picking it does. */
function leadReasonText(selected) {
  if (!selected) return '至少选择一条音轨后才能指定主音轨。';
  const label = selected.name ? `${selected.instrument} · ${selected.name}` : selected.instrument;
  if (state.leadBasis === 'manual') {
    return `已选「${label}」：玩家会站在这一条轨上，其余轨道按远近排在两侧。`;
  }
  return `自动推荐「${label}」：它是这几条轨里平均力度最高的一条，也就是全曲最响的那条。`;
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

  // Loudest first, so the top row is the recommendation: the list answers "which one
  // should I pick" by its order instead of asking the user to read a velocity percentage
  // and translate it. Rows carry the instrument and the track's own name, which is what
  // the file calls it - "轨 7" tells nobody anything.
  const ranked = [...chosen].sort((left, right) => {
    const velocity = right.meanVelocity - left.meanVelocity;
    if (velocity !== 0) return velocity;
    const notes = right.noteCount - left.noteCount;
    return notes !== 0 ? notes : left.index - right.index;
  });
  const list = $('leadTrackList');
  list.replaceChildren();
  for (const track of ranked) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'lead-row';
    row.setAttribute('role', 'option');
    row.dataset.trackIndex = String(track.index);
    const current = track.index === selected?.index;
    row.classList.toggle('selected', current);
    // Drums stay selectable but dimmed and labelled: a drum track is rarely what carries
    // the tune, yet hiding it outright would be wrong for the song where it does.
    row.classList.toggle('is-dim', Boolean(track.percussion));
    row.setAttribute('aria-selected', current ? 'true' : 'false');

    const name = document.createElement('span');
    name.className = 'lead-row-name';
    const label = track.name ? `${track.instrument} · ${track.name}` : track.instrument;
    name.textContent = `音轨 ${track.index + 1}：${label}`;

    const tag = document.createElement('span');
    tag.className = 'lead-row-tag';
    tag.textContent = track.percussion ? '打击乐 · 通常不是主音轨' : `${number(track.noteCount)} 个音符`;

    row.append(name, tag);
    list.append(row);
  }

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
  return JSON.stringify([
    state.midiPath,
    state.midiRevision,
    state.backend,
    excluded,
    lead,
    state.dMax,
    state.baseTps,
    state.outOfRange,
    state.laneSharing,
    state.laneShareSparseBelow,
    state.centerLead,
    state.laneRide,
    state.commandBudget,
  ]);
}

let smartTimer;
let smartPendingSignature;

function currentSmartMeasurement() {
  return state.smartSelection && state.smartSignature === selectionSignature() ? state.smartMeasured : null;
}

function scheduleSmartSelection() {
  clearTimeout(smartTimer);
  if (state.step !== 4 || !state.midiPath || !state.smartSelection) return;
  const signature = selectionSignature();
  if (signature === state.smartSignature || smartPendingSignature !== undefined) return;
  smartTimer = setTimeout(() => void applySmartSelection(), 180);
}

/** One line describing what the measurement decided. */
function smartRoutingText(info) {
  if (!info) return '';
  const mode = info.instrumentMode === 'extended' ? '扩展竖琴音域' : '原版乐器';
  if (state.backend === 'command') return `${mode} · 命令播放不判定听距、合并与借道`;
  const merge = MERGE_MODE_TEXT[info.mergeMode] ?? MERGE_MODE_TEXT.off;
  return `${mode} · ${merge} · 离主轨行最远 ${info.radiusZ} 格`;
}

function syncSmartPanel() {
  const badge = $('smartBadge');
  const button = $('btnSmartApply');
  const measurement = currentSmartMeasurement();
  button.disabled = smartPendingSignature !== undefined;
  if (smartPendingSignature === selectionSignature()) {
    badge.textContent = '计算中…';
    badge.dataset.state = 'busy';
    $('smartApplyResult').textContent = '';
  } else if (measurement) {
    badge.textContent = '已应用';
    badge.dataset.state = 'auto';
    button.textContent = '重新计算智能推荐';
    $('smartConfigHint').textContent =
      '已按当前音轨和参数计算。修改乐器或布局选项可切到手动，修改基准 TPS 等参数会重新计算。';
    $('smartApplyResult').textContent = smartRoutingText(measurement);
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
  if (!state.midiPath || smartPendingSignature !== undefined) return;
  clearTimeout(smartTimer);
  const token = ++state.smartToken;
  const signature = selectionSignature();
  const { instrumentMode, merge, smartSelection } = state;
  const stillCurrent = () =>
    token === state.smartToken &&
    signature === selectionSignature() &&
    instrumentMode === state.instrumentMode &&
    merge === state.merge &&
    smartSelection === state.smartSelection;
  smartPendingSignature = signature;
  syncSmartPanel();
  try {
    const { info, error } = await api.plan(state.midiPath, generateOptions(), state.midiRevision);
    if (!stillCurrent()) return;
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
    syncSummary();
  } catch (failure) {
    if (!stillCurrent()) return;
    state.smartSelection = false;
    state.smartMeasured = null;
    syncSummary();
    $('smartBadge').textContent = '无法计算';
    $('smartBadge').dataset.state = 'error';
    $('smartConfigHint').textContent =
      `智能推荐失败：${failure?.message || failure}。现在按下面的手动设置生成。`;
  } finally {
    smartPendingSignature = undefined;
    if ($('smartBadge').dataset.state !== 'error') syncSmartPanel();
    else $('btnSmartApply').disabled = false;
    scheduleSmartSelection();
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

/** Hide a card by id without throwing when the markup does not have it. */
function setCardHidden(id, hidden) {
  const card = document.getElementById(id);
  if (card) card.hidden = hidden;
}

function syncSummary() {
  syncSmartPanel();
  syncOptionBoxes();
  const extended = state.instrumentMode === 'extended';
  const pitch = extended ? '扩展竖琴音域 · 钢琴 F#1–F#7' : '原版乐器 · 各乐器两个八度';
  const columnCapacity = 2 * state.dMax + 1;
  const capacity =
    state.backend === 'command'
      ? ''
      : state.merge === 'force'
        ? ` · 紧凑列最多 ${Math.min(columnCapacity, 27)} 音，超出改用分段布线`
        : ` · 单列最多 ${columnCapacity} 音，超出拆轨`;
  $('sumPitch').textContent = pitch + capacity;
  const packWanted = currentSmartMeasurement()?.resourcePackRecommended ?? extended;
  $('packTitle').textContent = packWanted
    ? '配套资源包（可选，保存后自行安装）'
    : '配套资源包（当前设置不需要）';
  // A pack that this song does not need is not an option worth a card: it only changes the
  // five extended harp slots.
  $('packCard').hidden = !packWanted;
  if (packWanted) {
    $('packDescription').textContent =
      '把扩展竖琴使用的五个音色槽统一为钢琴采样。扩展音域由投影内的音符盒提供。保存后放进 .minecraft/resourcepacks/ 再自行启用。';
  }
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
  // Several cards cannot change the file in some configurations, and a switch that is
  // merely disabled still reads as "on" - which was reported as a bug. They are removed
  // instead: a forced merge leaves one spine (nothing to borrow or ride on), a single
  // track has nothing to order or merge with, and command playback has no lanes at all.
  const forced = state.merge === 'force';
  // Exactly one, not "at most one": before a song is loaded there are no tracks at all, and
  // hiding the cards then left them hidden after the import (the summary only runs on the
  // steps that change it, and loading a file is not one of them).
  const singleTrack = state.tracks.filter((track) => track.checked).length === 1;
  setCardHidden('leadPanel', singleTrack);
  setCardHidden('annotateCard', command);
  setCardHidden('centerLeadCard', singleTrack || command);
  setCardHidden('laneShareCard', singleTrack || command || forced);
  setCardHidden('laneRideCard', singleTrack || command || forced);
  for (const box of document.querySelectorAll('.opt-box[data-cfg-group="merge"]')) {
    box.hidden = singleTrack || command;
  }
  // The fold reads like a card title, not a status line: the switches below it already
  // show their own state, so repeating five of them in one run-on sentence was noise.
  $('sumMisc').textContent = mergeText;
  $('commandBudgetField').style.display = state.backend === 'command' ? 'flex' : 'none';
  // The readout is dev-only and cheap to skip; every option change lands here.
  scheduleSmartSelection();
  scheduleDevMeasure();
  syncJobControls();
  if (state.step === 6 && !activeJob && checkedSignature !== generationSignature()) void runCheck();
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

function syncOutputText() {
  $('outputPathText').textContent = state.output?.path ?? '尚未选择投影文件';
  syncJobControls();
}

async function chooseOutputFile() {
  if (state.choosingOutput || activeJob || !state.midiPath) return;
  const imported = importToken;
  const name = state.output?.path.split(/[\\/]/).pop() || suggestedName(state.midiPath, state.song?.name);
  state.choosingOutput = true;
  syncJobControls();
  try {
    const grant = await api.chooseOutput(name);
    if (!grant || imported !== importToken) return;
    state.output = grant;
    syncOutputText();
    if (grant.preferencesPersisted === false) notify('已选择保存位置，重启后可能需要重新选择文件夹。');
    playNote(480, 'sine', 0.08);
  } catch (error) {
    notify(`无法选择保存位置：${error?.message || error}`);
  } finally {
    state.choosingOutput = false;
    syncJobControls();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 6: generation
 * ──────────────────────────────────────────────────────────────────────────── */

let elapsedTimer = null;
let jobCounter = 0;
let activeJob = null;
let checkedSignature = null;

const stageText = {
  read: '正在读取 MIDI…',
  layout: '正在计算布局…',
  preview: '正在准备预览…',
  encode: '正在编码投影…',
  write: '正在保存投影…',
};

function generationSignature() {
  return JSON.stringify([state.midiPath, state.midiRevision, generateOptions()]);
}

function syncStepNavigation(hasCheckedLayout) {
  const imported = Boolean(state.midiPath) && !$('btnStep2Next').disabled;
  const tracksSelected = imported && state.tracks.some((track) => track.checked);
  const available = [
    true,
    true,
    imported,
    tracksSelected,
    tracksSelected,
    hasCheckedLayout,
    false,
    Boolean(state.result?.outputPath),
  ];
  stepNodes.forEach((node, index) => {
    const step = index + 1;
    const current = step === state.step;
    node.disabled = !current && !available[index];
    node.classList.toggle('current', current);
    node.classList.toggle('done', step < state.step);
    node.setAttribute('aria-current', current ? 'step' : 'false');
  });
}

function syncJobControls() {
  const busy = state.choosingOutput || activeJob !== null;
  const canExport = state.output !== null && !busy;
  $('btnChooseOutput').disabled = busy || !state.midiPath;
  $('btnStartGen').disabled = !canExport;
  const hasCheckedLayout = checkedSignature === generationSignature();
  $('btnGoGenerate').disabled = !canExport || !hasCheckedLayout;
  $('btnRetryGen').disabled = !canExport;
  $('btnCancelGeneration').disabled = activeJob?.cancelling === true || activeJob?.stage === 'write';
  syncStepNavigation(hasCheckedLayout);
}

function beginJob(kind) {
  if (activeJob) return null;
  activeJob = { id: ++jobCounter, kind, signature: generationSignature(), stage: 'read', cancelling: false };
  syncJobControls();
  return activeJob;
}

function finishJob(job) {
  if (activeJob === job) activeJob = null;
  syncJobControls();
}

async function cancelJob() {
  const job = activeJob;
  if (!job || job.cancelling || job.stage === 'write') return;
  job.cancelling = true;
  syncJobControls();
  try {
    await api.cancelGeneration?.(job.id);
  } catch (error) {
    job.cancelling = false;
    syncJobControls();
    notify('取消任务失败：' + (error?.message || error));
  }
}

api.onGenerationProgress?.((id, stage) => {
  const job = activeJob;
  if (!job || job.id !== id) return;
  job.stage = stage;
  syncJobControls();
  if (job.cancelling) return;
  if (job.kind === 'check' && state.step === 6) $('checkSummary').textContent = stageText[stage];
  if (job.kind === 'export' && state.step === 7) $('genStage').textContent = stageText[stage];
});

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
  if (!state.output) {
    showGenerateError('还没有选择保存位置。', '缺少输出位置');
    return;
  }

  const job = beginJob('export');
  if (!job) return;
  $('statusToast').classList.remove('visible');
  $('genStage').textContent = stageText.read;
  $('genErrorBox').style.display = 'none';
  $('genRunningBox').style.display = 'flex';
  $('genTitle').textContent = '正在生成投影';
  startElapsed();

  try {
    const result = await api.generate(
      state.midiPath,
      generateOptions(),
      state.output.token,
      job.id,
      state.midiRevision,
    );
    clearInterval(elapsedTimer);
    finishJob(job);
    if (job.signature !== generationSignature()) return;
    if (result.chooseOutputAgain) {
      state.output = null;
      syncOutputText();
      goStep(5);
      $('btnChooseOutput').focus();
      notify(result.error || '请重新选择保存位置。');
      return;
    }

    if (!result.success) {
      showGenerateError(result.error || '生成器没有给出原因。');
      return;
    }

    state.output = null;
    syncOutputText();
    state.result = result;
    showResult(result);
    setupPreviewButton();
    goStep(8);
    playSuccess();
  } catch (error) {
    finishJob(job);
    if (job.cancelling) {
      clearInterval(elapsedTimer);
      if (state.step === 7) goStep(6);
      notify('已取消生成。');
    } else {
      showGenerateError(error?.message || String(error));
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 7: result
 * ──────────────────────────────────────────────────────────────────────────── */

function showResult(result) {
  const blocks = result.regions.reduce((sum, region) => sum + region.blockCount, 0);
  const size = unionSize(result.regions);

  $('doneFileSub').textContent = result.outputPath
    ? result.outputPath.split(/[\\/]/).pop()
    : `${(result.song?.name || 'Musicbox').replace(/\.(mid|midi)$/i, '')}.litematic（未保存）`;

  $('doneBlocks').textContent = `${number(blocks)} 块`;
  $('doneDims').textContent = size ? `${number(size.x)} × ${number(size.y)} × ${number(size.z)}` : '—';
  $('doneSize').textContent = bytesText(result.bytes);

  const inputs = result.startInputs ?? [];
  $('doneTriggerHint').textContent =
    result.playbackMode === 'command'
      ? '启用命令方块，粘贴结构后按 Start / Restart 启动。'
      : inputs.length > 1
        ? `将 ${inputs.length} 个独立供电点接到同一个按钮，确保同一游戏刻送电。`
        : '在主线起点接上红石线和按钮。';
  $('doneInputs').hidden = inputs.length === 0;
  $('doneInputs').open = false;
  $('doneInputList').textContent = inputs.map(({ x, y, z }) => `(${x}, ${y}, ${z})`).join('、');
  const tps = result.song?.summaryTps ?? 20;
  $('doneTpsHint').textContent =
    tps === 20 ? '' : `基准为 ${tps} TPS。请在游戏中执行 /tick rate ${tps} 以保持原曲速度。`;
  $('doneTpsHint').hidden = tps === 20;

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
      // Unticking down to one track removes the cards that need several, so the summary has
      // to run here rather than waiting for the next step change.
      syncSummary();
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
    }
    syncSummary();
    // The notice invites the user to leave the defaults alone. Once they have not, it has
    // nothing left to say.
    $('configNotice').style.display = 'none';
    playNote(420, 'sine', 0.08);
  }
});

$('btnPrevStep').addEventListener('click', () => {
  if (state.step === 8) {
    goStep(checkedSignature === generationSignature() ? 6 : 5);
  } else if (state.step > 1) {
    goStep(state.step - 1);
  }
});

$('realFileInput').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) importMidiFile(file);
});

$('importEmpty').addEventListener('click', (event) => {
  // The question mark sits inside the drop zone; opening the file dialog from it would
  // cover the explanation the user just asked for.
  if (event.target.closest('.help-dot, .help-pop')) return;
  void chooseMidiFile();
});

/** The "what is a MIDI file" bubble: opened by the question mark, closed by anything else. */
function setMidiHelp(open) {
  $('helpMidi').hidden = !open;
  $('btnHelpMidi').setAttribute('aria-expanded', open ? 'true' : 'false');
}

$('btnHelpMidi').addEventListener('click', (event) => {
  event.stopPropagation();
  setMidiHelp($('helpMidi').hidden);
});

document.addEventListener('click', (event) => {
  if ($('helpMidi').hidden) return;
  if (event.target.closest('#helpMidi, #btnHelpMidi')) return;
  setMidiHelp(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('helpMidi').hidden) setMidiHelp(false);
});

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

function importMidiFile(file) {
  if (!/\.(mid|midi)$/i.test(file.name)) {
    showImportError('请选择 .mid 或 .midi 文件。');
    return;
  }
  try {
    const path = api.pathForFile(file);
    if (!path) {
      showImportError('无法读取所选文件的路径，请改用点击选择。');
      return;
    }
    void loadMidi(path);
  } catch {
    showImportError('无法读取所选文件的路径，请改用点击选择。');
  }
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
  importMidiFile(file);
});

// Without these, Chromium treats a drop outside the target as a navigation and
// replaces the app window with the dropped file.
window.addEventListener('dragover', (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
window.addEventListener('drop', (event) => event.preventDefault());
$('btnChangeFile').addEventListener('click', () => void chooseMidiFile());
$('btnResetImport').addEventListener('click', () => {
  importToken++;
  setImportView('empty');
});

$('btnToggleAllTracks').addEventListener('click', () => {
  const allChecked = state.tracks.every((track) => track.checked);
  state.tracks.forEach((track) => {
    track.checked = !allChecked;
  });
  renderTracks();
  syncSummary();
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

$('leadTrackList').addEventListener('click', (event) => {
  const row = event.target.closest('.lead-row');
  if (!row) return;
  const index = Number(row.dataset.trackIndex);
  if (!Number.isSafeInteger(index)) return;
  state.leadTrackIndex = index;
  state.leadBasis = 'manual';
  syncLeadPicker();
  // Picking a lead is not a rejection of the instrument mode or the merge the recommendation
  // chose, so smart selection stays on; the lead card and the check page both say "手动指定".
  syncSummary();
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
  syncSummary();
});

async function saveResourcePack() {
  try {
    const target = await savePack();
    if (!target) return; // Cancelled.
    notify('资源包已保存，把它放进 .minecraft/resourcepacks/ 再在游戏里启用');
    // Reveal it: finding the file afterwards is the awkward part of this feature.
    await api.reveal(target);
  } catch (error) {
    notify(`保存资源包失败：${error?.message || error}`);
  }
}
$('btnSavePack').addEventListener('click', () => void saveResourcePack());
$('btnGetResourcePack').addEventListener('click', () => void saveResourcePack());

$('btnChooseOutput').addEventListener('click', () => void chooseOutputFile());
$('btnStartGen').addEventListener('click', () => {
  if (activeJob) return;
  goStep(6);
  void runCheck();
});

// The check step's button is the only thing that writes a file.
$('btnGoGenerate').addEventListener('click', () => {
  if (activeJob || checkedSignature !== generationSignature()) return;
  goStep(7);
  void runGeneration();
});
$('btnBackToExport').addEventListener('click', () => goStep(5));
$('btnRetryGen').addEventListener('click', () => void runGeneration());
$('btnCancelGeneration').addEventListener('click', () => void cancelJob());

$('btnOpenFolder').addEventListener('click', () => {
  if (state.result?.outputPath) void api.reveal(state.result.outputPath);
  else notify('这份投影还没有保存到文件');
});

$('btnNextSong').addEventListener('click', () => {
  importToken++;
  state.smartToken++;
  devMeasureToken++;
  checkedSignature = null;
  state.midiPath = null;
  state.midiRevision = undefined;
  state.song = null;
  state.tracks = [];
  state.output = null;
  state.result = null;
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
let aboutLoading = false;
async function loadAbout() {
  if (aboutLoaded || aboutLoading) return;
  aboutLoading = true;
  try {
    const info = await api.appInfo();
    $('aboutVersion').textContent = info.version;
    $('aboutLicense').textContent = info.license;
    $('aboutAuthor').textContent = info.author;
    $('btnOpenRepo').addEventListener('click', () => void api.open(info.repository));
    aboutLoaded = true;
  } catch (error) {
    notify(`无法读取版本信息：${error?.message || error}`);
  } finally {
    aboutLoading = false;
  }
}

$('btnPackReminder').addEventListener('click', () => {
  void savePrefs({ packPromptMuted: !state.prefs.packPromptMuted });
  playNote(state.prefs.packPromptMuted ? 320 : 520, 'sine', 0.06);
});

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
  const mode = smart.instrumentMode === 'extended' ? '扩展竖琴音域' : '原版乐器';
  const mergeLabel = MERGE_MODE_TEXT;
  const lead = state.tracks.find((track) => track.index === smart.leadTrackIndex);
  const leadBasis =
    {
      manual: '手动指定',
      velocity: '平均 MIDI 力度最高',
      balance: '力度接近，综合活跃度与单音旋律',
      fallback: '没有可用有音律轨，使用当前音轨',
    }[smart.leadBasis] || '自动推荐';
  const leadLine = result.mergedAllTracks
    ? '主音轨：全曲合并成一条主线，没有独立主音轨（站到主线那一行）'
    : `主音轨：${lead ? `轨 ${lead.index + 1}「${lead.name || lead.instrument}」` : '未指定'} · ${leadBasis}`;

  const lines = [
    `分类：${category}`,
    `乐器模式：${mode}`,
    `资源包：${smart.resourcePackRecommended ? '建议保存，需自行安装' : '不需要'}`,
  ];
  if (result.playbackMode === 'command') {
    // Command playback has no lanes, no Z span and no merge, so none of those conclusions
    // apply; printing a lead track there would suggest a layout that does not exist.
    lines.push('主音轨 / 听距 / 合并方式：命令播放不适用');
  } else {
    lines.push(
      `离主轨行最远 ${smart.radiusZ} 格（Z 向阈值 ${smart.compactRadius} / ${smart.audibleRadius} 格）`,
      `合并方式：${mergeLabel[smart.mergeMode] ?? smart.mergeMode}`,
      leadLine,
    );
    if (result.preview?.size?.x > 2 * smart.audibleRadius) {
      lines.push('随播放沿 X 方向走动，保持在当前发声音符附近。');
    }
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
      .map((candidate) => `${mergeLabel[candidate.mode] ?? candidate.mode} Z 向最远 ${candidate.radiusZ} 格`)
      .join(' · ');
    if (candidates) lines.push(`候选布局：${candidates}`);
    const annotation = result.laneAnnotation;
    if (annotation) {
      const spot = annotation.player.z;
      lines.push(
        `投影注释：${annotation.signs.length} 条牌 · 跟随 Z ${spot} 行 · 横向最远 ${annotation.spreadZ} 格`,
      );
    }
  }

  $('smartResultDetail').textContent = lines.join('\n');
  panel.style.display = 'flex';
}

function renderIssues(result) {
  const list = $('issueList');
  list.replaceChildren();

  const warnings = result.warnings ?? [];
  const bySeverity = new Map(ISSUE_GROUPS.map((group) => [group.severity, []]));
  let actionable = 0;
  for (const warning of warnings) {
    const severity = warnSeverity(warning.code) === 'warn' ? 'warn' : 'info';
    if (severity === 'warn') actionable++;
    const items = bySeverity.get(severity);
    if (items.length < WARNING_DISPLAY_LIMIT) items.push(warning);
  }

  if (warnings.length === 0) {
    $('checkSummary').textContent = '没有发现问题，可以直接生成。';
    return;
  }

  const total = `共 ${number(warnings.length)} 条`;
  const advice = actionable > 0 ? `，其中 ${number(actionable)} 条建议处理。` : '，可展开查看。';
  let remaining = WARNING_DISPLAY_LIMIT;
  const hidden = warnings.length > remaining ? `另有 ${number(warnings.length - remaining)} 条未显示。` : '';
  $('checkSummary').textContent = total + advice + hidden;

  for (const group of ISSUE_GROUPS) {
    const items = bySeverity.get(group.severity).slice(0, remaining);
    remaining -= items.length;
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

/** A chip jumps to the first note on its track's actual circuit row. */
function renderTrackChips(result) {
  const box = $('previewTrackChips');
  box.replaceChildren();

  const firstRowOfTrack = new Map();
  for (const lane of result.previewLanes ?? []) {
    if (!firstRowOfTrack.has(lane.trackIndex)) firstRowOfTrack.set(lane.trackIndex, lane);
  }
  if (result.playbackMode === 'command' && result.regions?.[0]) {
    const { x, z } = result.regions[0].position;
    firstRowOfTrack.set(-1, { x, z });
  }

  for (const [index, { x, z }] of firstRowOfTrack) {
    const track = (result.tracks ?? []).find((entry) => entry.index === index);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pill-tag';
    chip.textContent =
      index < 0 ? '合并主线' : track?.name ? `${index + 1} ${track.name}` : `音轨 ${index + 1}`;
    chip.title = `跳到 z${z} 行`;
    chip.addEventListener('click', () => focusPreviewCell(x, z));
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

/** Analyze the selected layout without encoding or saving a file. */
async function runCheck() {
  if (!state.midiPath) return;
  const job = beginJob('check');
  if (!job) return;
  checkedSignature = null;
  $('checkSummary').textContent = stageText.read;
  $('issueList').replaceChildren();
  $('smartResult').style.display = 'none';
  const canApply = () => !job.cancelling && job.signature === generationSignature();

  try {
    const result = await api.generate(
      state.midiPath,
      generateOptions(),
      undefined,
      job.id,
      state.midiRevision,
    );
    if (!canApply()) return;
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

    checkedSignature = job.signature;
    renderIssues(result);
    renderSmartResult(result);
    renderTrackChips(result);
    renderAssignmentTable('assignmentTable', result);
    // The canvas measures its container, so this runs after the step is on screen.
    renderPreview(result);
    if (!result.warnings?.length) notify('没有发现问题，可以生成');
  } catch (error) {
    if (!canApply()) return;
    $('checkSummary').textContent = '这一遍没能跑完。';
    notify(`检查失败：${error?.message || error}`);
    playFailure();
  } finally {
    finishJob(job);
    if (!job.cancelling && job.signature !== generationSignature() && state.step === 6) {
      void runCheck();
    }
  }
}

// Panning and the layer toggles. The drawing module exposes the operations but binds
// nothing itself, so the controls live here.
for (const id of ['showGrid', 'showNotes']) {
  $(id).addEventListener('change', () => renderPreview());
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
  // A wheel or a trackpad swipe arrives many times per frame, and each pan used to redraw
  // the whole schematic synchronously. The deltas are accumulated and one draw is made per
  // frame, the same way the drag is handled.
  let wheelPending = 0;
  let wheelFrame = 0;
  const flushWheel = () => {
    wheelFrame = 0;
    if (!wheelPending) return;
    const pixels = wheelPending;
    wheelPending = 0;
    panPreview(pixels, 0);
  };
  wrap.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      wheelPending += event.deltaX !== 0 ? event.deltaX : event.deltaY;
      if (!wheelFrame) wheelFrame = requestAnimationFrame(flushWheel);
    },
    { passive: false },
  );
})();

// The interface check drives the drawing from the outside: it needs to see the view move a
// fraction of a cell, and to prove a pan reuses cached tiles instead of rebuilding them.
// The view lives in the drawing module's state, not in this file's, so it is read back
// from there rather than copied here.
window.__preview = {
  view: () => previewDiagnostics().view,
  diagnostics: () => previewDiagnostics(),
};

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
        packRecommended: currentSmartMeasurement()?.resourcePackRecommended,
      },
      options: state.midiPath ? generateOptions() : null,
      output: { path: state.output?.path ?? null, hasToken: Boolean(state.output?.token) },
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
  devMeasureToken++;
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
    `离主轨行最远 ${measure.hearingRadius} 格`,
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
    const measure = await api.measure(state.midiPath, generateOptions(), state.midiRevision);
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
syncPackReminderButton();
goStep(1);

// Remembered choices arrive after the first paint: neither one changes the first screen,
// and waiting for them would delay the window for a file read.
if (typeof api.getPreferences === 'function') {
  void api
    .getPreferences()
    .then((preferences) => {
      state.prefs = preferences;
      syncPackReminderButton();
    })
    .catch((error) => devLog('prefs', { error: error?.message || String(error) }));
}
