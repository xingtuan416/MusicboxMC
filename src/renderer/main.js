import { $, api, state } from './state.js';
import { log } from './log.js';
import { updateWorkflowUI, switchTab } from './workflow.js';
import { renderPreview, setPreviewScale, fitPreview } from './preview.js';
import { doAnalyze, doBrowse, doGenerate } from './actions.js';
import { syncPitchRangeHint } from './options.js';

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
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }

  for (const id of ['showGrid', 'showNotes']) {
    $(id).addEventListener('change', () => {
      if (state.generated) renderPreview(state.generated);
    });
  }

  $('previewZoomOut').addEventListener('click', () => {
    setPreviewScale(state.previewScale - 0.1);
  });
  $('previewZoomIn').addEventListener('click', () => {
    setPreviewScale(state.previewScale + 0.1);
  });
  $('previewFit').addEventListener('click', fitPreview);
}

bind();
api.onLog((line) => log(line));
updateWorkflowUI('waiting');
log('界面就绪。选择 MIDI 文件开始。');
