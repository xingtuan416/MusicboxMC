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
