import { $, api, state } from './state.js';
import { log } from './log.js';
import { banner, hideBanner } from './banner.js';
import { updateWorkflowUI, switchTab } from './workflow.js';
import { collectOptions } from './options.js';
import { renderOverview } from './overview.js';
import { renderTrackList } from './tracklist.js';
import { renderWarnings } from './warnings.js';
import { renderPreview } from './preview.js';
import { fmtBytes } from './dom.js';

function setBusy(on) {
  state.busy = on;
  $('btnGenerate').disabled = on || !state.analyze;
  $('btnAnalyze').disabled = on;
  $('btnBrowse').disabled = on;
}

async function doBrowse() {
  try {
    const path = await api.chooseMidi();
    if (!path) return;
    $('filePath').value = path;
    updateWorkflowUI('reading');
    log(`已选择文件 ${path}`);
    await doAnalyze();
  } catch (e) {
    updateWorkflowUI('error');
    banner('err', String(e.message || e));
    log(`选择文件失败：${e.message || e}`);
  }
}

async function doAnalyze() {
  const path = $('filePath').value.trim();
  if (!path) {
    updateWorkflowUI('waiting');
    banner('err', '请先选择 MIDI 文件。');
    return;
  }
  hideBanner();
  setBusy(true);
  updateWorkflowUI('reading');
  try {
    const res = await api.analyze(path);
    state.analyze = res;
    renderOverview(res);
    renderTrackList(res);
    renderWarnings([]);

    // Build the layout in memory right after parsing so the circuit preview works
    // without writing a file.
    // Clicking "generate" later re-runs it with the user's latest settings and saves
    // the result.
    try {
      updateWorkflowUI('generating', res);
      const previewRes = await api.generate(path, collectOptions());
      state.generated = previewRes;
      if (!previewRes.success) renderOverview(previewRes);
      renderWarnings(previewRes.warnings || []);
      renderPreview(previewRes);
      updateWorkflowUI(previewRes.success ? 'ready' : 'error', previewRes);
      if (previewRes.success) {
        log(
          `预览准备完成：${previewRes.playbackMode === 'command' ? `${previewRes.stats.commandBlockCount} 命令方块` : `${previewRes.stats.noteBlockCount} 音符盒`} / ${previewRes.stats.regionCount} 个区域`,
        );
      } else {
        log(`预览准备失败：${previewRes.error || '未知错误'}`);
      }
    } catch (e) {
      state.generated = null;
      renderPreview(null);
      updateWorkflowUI('error');
      log(`预览准备失败：${e.message || e}`);
    }

    log(`解析完成：${res.file} · ${res.song.noteCount} 音符 / ${res.tracks.length} 轨`);
    switchTab('overview');
  } catch (e) {
    state.analyze = null;
    state.generated = null;
    renderPreview(null);
    updateWorkflowUI('error');
    banner('err', String(e.message || e));
    log(`解析失败：${e.message || e}`);
  } finally {
    setBusy(false);
    $('btnGenerate').disabled = !state.analyze;
  }
}

async function doGenerate() {
  const path = $('filePath').value.trim();
  if (!path) return;

  // Ask for an output path first when none is set, so a generated file never ends up
  // somewhere the user cannot find.
  let out = $('outputPath').value.trim();
  if (!out) {
    try {
      const suggested = ($('filePath').value.split(/[\\/]/).pop() || 'output').replace(/\.midi?$/i, '');
      const picked = await api.chooseOutput(suggested);
      if (picked) {
        out = picked;
        $('outputPath').value = picked;
      }
    } catch (e) {
      log(`选择保存位置失败：${e.message || e}`);
    }
  }

  hideBanner();
  setBusy(true);
  updateWorkflowUI('generating', state.analyze);
  switchTab('overview');
  log(`开始生成… ${out ? `输出到 ${out}` : '（不落盘）'}`);
  try {
    const res = await api.generate(path, collectOptions(), out || undefined);
    state.generated = res;
    renderOverview(res);
    renderWarnings(res.warnings);
    renderPreview(res);
    updateWorkflowUI(res.success ? 'generated' : 'error', res);
    log(
      `生成${res.success ? '成功' : '失败'}：${res.success ? `${res.playbackMode === 'command' ? `${res.stats.commandBlockCount} 命令方块` : `${res.stats.noteBlockCount} 音符盒`} / ${fmtBytes(res.bytes)} / ${res.stats.elapsedMs}ms` : res.error}`,
    );
    if (res.outputPath) log(`已保存：${res.outputPath}`);
  } catch (e) {
    updateWorkflowUI('error');
    banner('err', String(e.message || e));
    log(`生成失败：${e.message || e}`);
  } finally {
    setBusy(false);
  }
}

export { setBusy, doBrowse, doAnalyze, doGenerate };
