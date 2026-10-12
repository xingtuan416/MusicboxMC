import { $, api, state } from './state.js';
import { log } from './log.js';
import { updateWorkflowUI, switchTab } from './workflow.js';
import { renderPreview, zoomPreview, panPreview, fitPreview, ZOOM_STEP } from './preview.js';
import { doAnalyze, doBrowse, doGenerate } from './actions.js';
import { syncPitchRangeHint } from './options.js';
import { saveResourcePack } from './resourcepack.js';

function bind() {
  const syncPlaybackSettings = () => {
    const command = $('commandPlayback').checked;
    const merge = $('mergeSameInstrument').checked;
    if (!merge) $('forceMergeSameInstrument').checked = false;
    $('forceMergeRow').classList.toggle('hidden', !merge);
    $('forceMergeSameInstrument').disabled = !merge || command;
    $('mergeSameInstrument').disabled = command;
    $('dMax').disabled = command;
    $('commandBudgetField').classList.toggle('hidden', !command);
  };
  $('mergeSameInstrument').addEventListener('change', syncPlaybackSettings);
  $('commandPlayback').addEventListener('change', syncPlaybackSettings);
  syncPlaybackSettings();
  $('extendedRange').addEventListener('change', syncPitchRangeHint);
  $('btnSavePack').addEventListener('click', () => saveResourcePack());
  syncPitchRangeHint();
  $('btnBrowse').addEventListener('click', doBrowse);
  $('btnAnalyze').addEventListener('click', doAnalyze);
  $('btnGenerate').addEventListener('click', doGenerate);

  $('filePath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAnalyze();
  });

  $('btnSaveAs').addEventListener('click', async () => {
    const current = $('outputPath').value.trim();
    const suggested =
      current || ($('filePath').value.split(/[\\/]/).pop() || 'output').replace(/\.midi?$/i, '');
    const picked = await api.chooseOutput(suggested.replace(/\.litematic$/i, ''));
    if (picked) {
      $('outputPath').value = picked;
      log(`输出路径设为 ${picked}`);
    }
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
      // The canvas is sized from its container, which has no size at all while the pane
      // is hidden, so the view has to be drawn again once it is on screen.
      if (tab.dataset.tab === 'preview' && state.generated) renderPreview(state.generated);
    });
  }

  for (const id of ['showGrid', 'showNotes']) {
    $(id).addEventListener('change', () => {
      if (state.generated) renderPreview(state.generated);
    });
  }

  $('previewZoomOut').addEventListener('click', () => zoomPreview(1 / ZOOM_STEP));
  $('previewZoomIn').addEventListener('click', () => zoomPreview(ZOOM_STEP));
  $('previewFit').addEventListener('click', fitPreview);

  // The canvas is viewport-sized, so it cannot scroll itself: panning is ours to do.
  const wrap = $('canvasWrap');
  wrap.addEventListener(
    'wheel',
    (event) => {
      if (!state.generated) return;
      event.preventDefault();
      if (event.ctrlKey) zoomPreview(event.deltaY < 0 ? 1.12 : 1 / 1.12);
      else panPreview(event.deltaX, event.deltaY);
    },
    { passive: false },
  );

  let dragFrom = null;
  wrap.addEventListener('pointerdown', (event) => {
    if (!state.generated) return;
    dragFrom = { x: event.clientX, y: event.clientY };
    wrap.setPointerCapture(event.pointerId);
  });
  wrap.addEventListener('pointermove', (event) => {
    if (!dragFrom) return;
    panPreview(dragFrom.x - event.clientX, dragFrom.y - event.clientY);
    dragFrom = { x: event.clientX, y: event.clientY };
  });
  const endDrag = (event) => {
    if (!dragFrom) return;
    dragFrom = null;
    if (wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId);
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
}

bind();
api.onLog((line) => log(line));
updateWorkflowUI('waiting');
log('界面就绪。选择 MIDI 文件开始。');
