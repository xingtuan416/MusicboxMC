export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlacedNote {
  /** 音符盒坐标 */
  notePos: Vec3;
  /** 垫底方块坐标 */
  blockPos: Vec3;
  /** 音符盒档位 0-24 */
  note: number;
  /** 垫底方块 id */
  block: string;
  /** 从分叉点到该音符盒的路径格（不含起点，含终点） */
  path: Vec3[];
}

/**
 * 主线上的一个分叉点：同一红石刻发声的一组音符。
 *
 * `x` 是分线列所在的格，`t` 是该组在主线上到达的红石刻。
 */
export interface Tap {
  /** 分线列的 X */
  x: number;
  /** 主线到达该分叉点的红石刻 */
  t: number;
  notes: PlacedNote[];
}

export interface BlockPlacement {
  pos: Vec3;
  /** 方块 id */
  block: string;
  props?: Record<string, string>;
}

export interface TrackSkeleton {
  trackIndex: number;
  zBase: number;
  placements: BlockPlacement[];
  taps: Tap[];
}

export type LayoutWarning =
  | { code: 'COMMAND_PLAYBACK_REQUIREMENTS'; chainLength: number; budget: number }
  | { code: 'COMMAND_SOUND_PRESSURE'; peakNotes: number }
  /**
   * 命令播放器的方块总数超过安全参考值：粘贴/加载会明显变慢。
   *
   * 健康结构只随「帧数 + 音色数 + 复用槽位数」增长，与音符总数无关；
   * 历史实现曾按音符逐个放命令方块（Rush E 46291 音 → 46308 块），
   * 该告警就是为拦截这一类回归而设。
   */
  | { code: 'COMMAND_STRUCTURE_SIZE'; commandBlocks: number; limit: number }
  | { code: 'POLYPHONY_EXCEEDED'; tick: number; n: number; limit: number }
  | { code: 'OUT_OF_RANGE'; midi: number; action: string }
  | { code: 'TIMING_ADJUSTED'; tick: number; actual: number }
  /** 密集音群放不下，已改派到新音轨 */
  | { code: 'TRACK_SPLIT'; tick: number; notes: number }
  /** Song-wide startup compensation in game ticks; music-relative timing is unchanged. */
  | { code: 'FORCE_MERGE_LEAD_IN'; ticks: number; peakNotes: number; sectionCapacity: number }
  /** One chord's bus was extended with renewed power, not split into playback tracks. */
  | { code: 'FANOUT_EXPANDED'; tick: number; n: number; limit: number; stages: number }
  /** 该处无法用红石线补齐跟上共享 X 参考线：报告时间与格数偏差，不改时值、不丢音 */
  | { code: 'SPATIAL_DRIFT'; tick: number; drift: number };

export interface LayoutResult {
  tracks: TrackSkeleton[];
  size: Vec3;
  /** 全图最小 x/y/z（用于把坐标平移到 litematic 的局部坐标系） */
  min: Vec3;
  totalTicks: number;
  /** Uniform startup latency in game ticks for the opt-in forced layout. */
  startupDelayTicks?: number;
  warnings: LayoutWarning[];
  /** 每个已放置音群的期望 tick 与实际触发 tick（按音轨顺序） */
  placed: Array<{ trackIndex: number; zBase: number; tick: number; actual: number }>;
}

export interface LayoutConfig {
  baseTps: number;
  /**
   * 电路层：红石线、中继器、音符盒都在这一层。
   *
   * 之所以只有一层，是因为音符盒**正上方必须是空气**才发声，
   * 所以红石线不能压在音符盒上方，只能与它同层相邻。
   */
  circuitY: number;
  /** 地板层，在电路层正下方，防止红石线悬空掉落 */
  floorY: number;
  /** 分线列单侧最多延伸多少行；总和弦容量为 2*dMax + 1 */
  dMax: number;
  trackPitch: number | 'auto';
}
