import { $ } from './state.js';

function updateWorkflowUI(stage, res) {
  const steps = ['stepImport', 'stepSettings', 'stepPreview', 'stepExport'];
  const stepIndex =
    {
      waiting: 0,
      reading: 0,
      ready: 1,
      generating: 2,
      generated: 3,
      error: 0,
    }[stage] ?? 0;

  for (const [index, id] of steps.entries()) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle('done', index < stepIndex || stage === 'generated');
    el.classList.toggle('active', index === stepIndex && stage !== 'generated');
  }

  const workflowState = $('workflowState');
  const fileState = $('fileState');
  const controlState = $('controlState');
  const resultStatus = $('resultStatus');
  const workspaceTitle = $('workspaceTitle');
  const workspaceSubtitle = $('workspaceSubtitle');

  if (stage === 'waiting') {
    workflowState.textContent = '等待导入文件';
    fileState.textContent = '尚未选择文件';
    controlState.textContent = '等待解析';
    resultStatus.textContent = '等待解析';
    workspaceTitle.textContent = '还没有曲目';
    workspaceSubtitle.textContent = '选择 MIDI 文件后，这里会显示曲目结构和电路结果。';
    return;
  }

  if (stage === 'reading') {
    workflowState.textContent = '正在读取曲目';
    fileState.textContent = '正在解析…';
    controlState.textContent = '读取中';
    resultStatus.textContent = '读取中';
    return;
  }

  if (stage === 'generating') {
    workflowState.textContent = '正在生成预览';
    fileState.textContent = res?.file || '已选择文件';
    controlState.textContent = '参数已加载';
    resultStatus.textContent = '生成中';
    return;
  }

  if (stage === 'error') {
    workflowState.textContent = '需要处理';
    fileState.textContent = '文件读取失败';
    controlState.textContent = '请重试';
    resultStatus.textContent = '出现问题';
    return;
  }

  const file = res?.file || res?.song?.name || '已选择文件';
  const song = res?.song;
  const summary = song
    ? `${song.durationText} · ${song.trackCount} 条音轨 · ${song.noteCount} 个音符`
    : '可以继续调整参数';
  fileState.textContent = file;
  workspaceTitle.textContent = song?.name || file;
  workspaceSubtitle.textContent = summary;

  if (stage === 'generated') {
    workflowState.textContent = '投影已生成';
    controlState.textContent = '已完成';
    resultStatus.textContent = '已生成';
  } else {
    workflowState.textContent = '可以开始设置';
    controlState.textContent = '可以调整';
    resultStatus.textContent = '已读取';
  }
}

function switchTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
    tab.setAttribute('aria-selected', tab.dataset.tab === name ? 'true' : 'false');
  }
  for (const pane of document.querySelectorAll('.tabpane')) {
    pane.classList.toggle('active', pane.id === `pane-${name}`);
  }
}

export { updateWorkflowUI, switchTab };
