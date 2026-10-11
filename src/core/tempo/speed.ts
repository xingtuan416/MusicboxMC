import { BASE_TPS } from './tick';

export interface SpeedRow {
  /** 倍率，1.0 为原速 */
  factor: number;
  /** 对应的 /tick rate 值 */
  tickRate: number;
  /** 实际播放时长（秒） */
  durationSec: number;
}

/**
 * 变速换算表：`/tick rate` 把游戏刻速率提到 baseTps × factor，
 * 于是实际时长 = 曲目时长 / factor。
 */
export function speedTable(durationSec: number, presets: number[], baseTps: number = BASE_TPS): SpeedRow[] {
  return presets.map((factor) => {
    const tickRate = baseTps * factor;
    return {
      factor,
      tickRate,
      durationSec: durationSec * (baseTps / tickRate),
    };
  });
}

/** 格式化为 mm:ss.s */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
