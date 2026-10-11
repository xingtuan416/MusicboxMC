import type { NoteEvent, SongModel, TrackModel } from '../../src/core/midi/types';

/**
 * 测试用的 SongModel 构造器。
 *
 * 十个测试文件原本各自手写一份 SongModel / TrackModel / NoteEvent 的字面量，
 * 内容几乎相同，改一次模型就要改十处。这里集中一次，各测试只描述自己关心的
 * 那部分：音轨、音符、乐器。
 *
 * 约定：`tick` 是游戏刻（20/秒），与布局层的时间基准一致；时值与力度固定为
 * 0.1s / 1.0，因为生成器不使用 MIDI 的时值与力度。
 */

export const TEST_TPS = 20;

export interface NoteSpec {
  /** 触发时刻（游戏刻） */
  tick: number;
  midi: number;
}

export interface TrackSpec {
  notes: NoteSpec[];
  instrument?: string;
  percussion?: boolean;
  name?: string;
  /** 覆盖音轨编号；缺省按数组下标。 */
  index?: number;
}

export interface SongSpec {
  tracks: TrackSpec[];
  name?: string;
  durationSec?: number;
}

/** 展开成完整的音符事件。 */
function toEvents(notes: NoteSpec[], channel: number): NoteEvent[] {
  return notes.map((note) => ({
    midi: note.midi,
    timeSec: note.tick / TEST_TPS,
    durationSec: 0.1,
    velocity: 1,
    channel,
  }));
}

/** 完整形态：逐轨给出音符、乐器与打击乐标记。 */
export function buildSong(spec: SongSpec): SongModel {
  return {
    name: spec.name ?? 'test-song',
    ppq: 480,
    durationSec: spec.durationSec ?? 8,
    baseBpm: 120,
    tempos: [{ ticks: 0, timeSec: 0, bpm: 120 }],
    timeSignature: null,
    tracks: spec.tracks.map((track, position): TrackModel => {
      const index = track.index ?? position;
      const channel = track.percussion ? 9 : index;
      return {
        index,
        name: track.name ?? `track-${index}`,
        channel,
        instrument: track.instrument ?? 'acoustic grand piano',
        percussion: track.percussion ?? false,
        notes: toEvents(track.notes, channel),
      };
    }),
  };
}

/** 最常见形态：一条钢琴轨。 */
export function song(notes: NoteSpec[], overrides: Partial<SongSpec> = {}): SongModel {
  return buildSong({ ...overrides, tracks: [{ notes }] });
}

/** 多轨，每轨只给音符（音高/时间），不带乐器信息。 */
export function songOfTracks(tracks: NoteSpec[][], overrides: Partial<SongSpec> = {}): SongModel {
  return buildSong({ ...overrides, tracks: tracks.map((notes) => ({ notes })) });
}

/** 多轨，每轨可单独指定乐器与打击乐标记。 */
export function songOfSpecs(tracks: TrackSpec[], overrides: Partial<SongSpec> = {}): SongModel {
  return buildSong({ ...overrides, tracks });
}

export interface DenseSongOptions {
  /** 音轨数，缺省 12。 */
  tracks?: number;
  durationSec?: number;
  /** 全曲音符总数，缺省 40000。 */
  notes?: number;
  /** 音高范围（半音数），缺省 48。 */
  pitchSpan?: number;
  /** 低音区起点，缺省 36。 */
  baseMidi?: number;
  /** 突发和弦的数量，缺省 200。 */
  bursts?: number;
  /** 每个突发和弦的音数，缺省 60。 */
  burstSize?: number;
}

/**
 * 密集曲目夹具：多轨、长时长、数万音符，且含大量同刻和弦。
 *
 * 生成器真正吃力的输入是"音符远多于时刻"的密集谱面，而不是某首具体的曲子；
 * 关键特征是**突发和弦**（几十个音落在同一游戏刻），它决定和弦容量、分支深度
 * 与命令播放的峰值压力。这里按确定性方式合成一份同等量级的输入，因此测试
 * **不依赖任何外部 MIDI 文件**，在别人的机器和 CI 上都会照常运行 —— 依赖
 * 本地文件的测试会静默跳过，等于作者本地跑的测试比贡献者多。
 */
export function denseSong(options: DenseSongOptions = {}): SongModel {
  const trackCount = options.tracks ?? 12;
  const durationSec = options.durationSec ?? 140;
  const noteCount = options.notes ?? 40000;
  const pitchSpan = options.pitchSpan ?? 48;
  const baseMidi = options.baseMidi ?? 36;
  const bursts = options.bursts ?? 200;
  const burstSize = options.burstSize ?? 60;

  const totalTicks = durationSec * TEST_TPS;
  const burstNotes = Math.min(noteCount, bursts * burstSize);
  const spreadNotes = noteCount - burstNotes;

  const tracks: TrackSpec[] = Array.from({ length: trackCount }, () => ({ notes: [] }));
  let placed = 0;
  const push = (tick: number, midi: number): void => {
    tracks[placed % trackCount]!.notes.push({ tick, midi });
    placed += 1;
  };

  // 突发和弦：均匀散布在全曲，模拟密集段落的同刻音群。
  for (let b = 0; b < bursts && placed < burstNotes; b++) {
    const tick = Math.floor(((b + 0.5) * totalTicks) / bursts);
    for (let k = 0; k < burstSize && placed < burstNotes; k++) {
      push(tick, baseMidi + ((b * 13 + k) % pitchSpan));
    }
  }

  // 其余音符均匀铺开，保证整曲都有内容而不是只有几处尖峰。
  for (let i = 0; i < spreadNotes; i++) {
    push(Math.floor((i * totalTicks) / spreadNotes), baseMidi + ((i * 7) % pitchSpan));
  }

  return buildSong({ name: 'dense-fixture', durationSec, tracks });
}
