import { $ } from './state.js';
import { card, create, fmtBytes, kv, table } from './dom.js';
import { banner, resetBanner } from './banner.js';
import { WARN_TEXT } from './warnings.js';
import { pitchRangeLabel } from './pitch.js';

function renderOverview(res) {
  const box = $('overview');
  box.className = '';
  box.replaceChildren();
  resetBanner();

  const s = res.song;
  const overviewHero = create('div', 'overview-hero');
  const heroCopy = create('div', 'overview-hero-copy');
  heroCopy.append(
    create('p', 'eyebrow', res.success ? 'GENERATED PROJECTION' : 'MIDI SUMMARY'),
    create('h3', null, s.name || res.file || '未命名曲目'),
    create(
      'p',
      null,
      res.success
        ? '投影已经生成，可以打开电路预览检查最终布局。'
        : '曲目已经读取，可以继续调整参数并生成投影。',
    ),
  );
  const metrics = create('div', 'overview-metrics');
  const metricPairs = [
    [s.durationText, '时长'],
    [s.baseBpm ? `${s.baseBpm}` : '—', 'BPM'],
    [s.noteCount, '音符'],
    [s.trackCount, '音轨'],
  ];
  for (const [value, labelText] of metricPairs) {
    const metric = create('div', 'overview-metric');
    metric.append(create('strong', null, String(value)), create('span', null, labelText));
    metrics.append(metric);
  }
  overviewHero.append(heroCopy, metrics);
  box.append(overviewHero);

  box.append(
    card(
      '曲目',
      kv([
        ['文件', res.file],
        ['曲名', s.name || '(无)'],
        ['PPQ', s.ppq],
        ['基准 BPM', s.baseBpm],
        ['拍号', s.timeSignature ? s.timeSignature.join('/') : '(无)'],
        ['时长', s.durationText],
        ['量化误差上限', `±${s.quantizeErrorMs}ms`],
        ['音轨 / 音符', `${s.trackCount} / ${s.noteCount}`],
      ]),
    ),
  );

  if (res.tracks.length > 0) {
    box.append(
      card(
        '音轨',
        table(
          ['#', '名称', '乐器', 'Ch', '音符', { label: 'tick 范围', num: true }],
          res.tracks.map((t) => [
            t.index,
            (t.name || '(无名)') + (t.percussion ? ' [打击乐]' : ''),
            t.instrument,
            t.channel,
            t.noteCount,
            t.noteCount > 0 ? `${t.minTick}–${t.maxTick}` : '—',
          ]),
        ),
      ),
    );
  }

  if (res.tempoSegments.length > 0) {
    box.append(
      card(
        `变速段 (${res.tempoSegments.length})`,
        table(
          [
            { label: 'tick', num: true },
            { label: '时间 (s)', num: true },
            { label: 'BPM', num: true },
          ],
          res.tempoSegments.map((t) => [t.ticks, t.timeSec.toFixed(3), t.bpm.toFixed(2)]),
        ),
      ),
    );
  }

  if (res.success === false) {
    banner('err', `生成失败：${res.error}`);
  } else if (res.success) {
    const parts = [
      res.playbackMode === 'command'
        ? `生成成功：${res.commandPlayback.playedNotes} 个播放音符 / ${res.stats.commandBlockCount} 个命令方块`
        : `生成成功：${res.stats.noteBlockCount} 个音符盒 / ${res.stats.circuitBlocks} 个电路方块`,
      `${res.stats.regionCount} 个区域`,
      `${fmtBytes(res.bytes)}`,
      `${res.stats.elapsedMs}ms`,
    ];
    banner('ok', parts.join(' · '));
  }

  if (res.success) {
    if (res.playbackMode === 'command') {
      banner(
        'warn',
        WARN_TEXT.COMMAND_PLAYBACK_REQUIREMENTS({
          chainLength: res.commandPlayback.chainLength,
          budget: res.commandPlayback.chainBudget,
        }),
      );
      const soundWarning = res.warnings.find((warning) => warning.code === 'COMMAND_SOUND_PRESSURE');
      if (soundWarning) banner('warn', WARN_TEXT.COMMAND_SOUND_PRESSURE(soundWarning));
      const sizeWarning = res.warnings.find((warning) => warning.code === 'COMMAND_STRUCTURE_SIZE');
      if (sizeWarning) banner('warn', WARN_TEXT.COMMAND_STRUCTURE_SIZE(sizeWarning));
    }
    const startup = (res.warnings || []).find((w) => w.code === 'FORCE_MERGE_LEAD_IN');
    if (startup) banner('warn', WARN_TEXT.FORCE_MERGE_LEAD_IN(startup));
    box.append(
      card(
        '生成统计',
        kv([
          ['总 tick 数', res.stats.tickCount],
          ['播放方式', res.playbackMode === 'command' ? '命令方块' : '红石音符盒'],
          ['音符盒', res.stats.noteBlockCount],
          ['命令方块', res.stats.commandBlockCount],
          ['播放音符', res.commandPlayback?.playedNotes],
          ['峰值同刻音符', res.commandPlayback?.peakNotes],
          ['命令链步骤', res.commandPlayback?.chainLength],
          ['电路方块', res.stats.circuitBlocks],
          ['区域数', res.stats.regionCount],
          [res.playbackMode === 'command' ? '播放器' : '输出主线', res.stats.outputTrackCount],
          ['启动等待', `${res.stats.startupDelayTicks || 0} 游戏刻`],
          ['投影大小', fmtBytes(res.bytes)],
          ['耗时', `${res.stats.elapsedMs}ms`],
          ['输出路径', res.outputPath],
        ]),
      ),
    );
    if (res.commandPlayback) {
      const coords = (pos) => `${pos.x}, ${pos.y}, ${pos.z}`;
      box.append(
        card(
          '播放器控制',
          kv([
            ['开始 / 重播坐标', coords(res.commandPlayback.start)],
            ['停止坐标', coords(res.commandPlayback.stop)],
            ['坐标基准', '投影原点（未旋转）'],
            ['计分板命名空间', res.commandPlayback.objective],
          ]),
        ),
      );
    }

    box.append(
      card(
        '区域',
        table(
          ['名称', '原点 (x,y,z)', '尺寸 (x,y,z)', { label: '方块', num: true }],
          res.regions.map((r) => [
            r.name,
            `${r.position.x},${r.position.y},${r.position.z}`,
            `${r.size.x}×${r.size.y}×${r.size.z}`,
            r.blockCount,
          ]),
        ),
      ),
    );

    box.append(
      card(
        '变速换算表',
        table(
          [
            { label: '倍率', num: true },
            { label: 'tick rate', num: true },
            { label: '实际时长', num: true },
          ],
          res.speedTable.map((r) => [`${r.factor.toFixed(2)}×`, r.tickRate, fmtDuration(r.durationSec)]),
        ),
      ),
    );

    // Notes outside the pitch range must be reported; silent degradation is not an
    // option. This cannot share a line with "generated successfully" or it gets
    // skimmed past, so it gets its own paragraph and a prefix.
    if (res.outOfRangeNotes > 0) {
      banner(
        'warn',
        `⚠ 音域提醒：${res.outOfRangeNotes} 个音符超出电路音域 ${pitchRangeLabel(res.pitchRange)}。` +
          `这些音符已按当前策略处理；八度移调和最近可用音会改变音高，跳过则不会写入这些音符。`,
      );
    }
  }
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export { renderOverview };
