import { CoreError, type CoreErrorCode, type CoreErrorDetails } from '../core/errors';

/**
 * Chinese text for every failure the core can report.
 *
 * The core raises structured codes so it can stay free of user-facing copy; this is
 * the single place that turns them into something a person reads. The `Record` type
 * makes the mapping exhaustive: adding a code to the core without adding its text
 * here is a compile error.
 */

/** Read a detail, marking it visibly if the raising site forgot to pass it. */
function value(details: CoreErrorDetails, key: string): string {
  return details[key] === undefined ? `?${key}` : String(details[key]);
}

const CORE_ERROR_TEXT: Record<CoreErrorCode, (details: CoreErrorDetails) => string> = {
  COMMAND_INVALID_TPS: () => '命令播放要求有效的 TPS',
  COMMAND_INVALID_BUDGET: (d) => `命令链预算必须是 1–${value(d, 'max')} 的整数`,
  COMMAND_INVALID_TRANSPOSE: () => '命令播放移调必须是有限数值',
  COMMAND_TIME_OUT_OF_RANGE: () => '命令播放时间超出计分板安全范围',
  COMMAND_NO_NOTES: () => '没有可生成的音符（可能全部被排除或音域策略丢弃）',
  COMMAND_CHAIN_TOO_LONG: (d) =>
    `命令播放需 ${value(d, 'chainLength')} 个链步骤，必须小于预算 ${value(d, 'budget')}；未生成投影`,
  COMMAND_CHAIN_DISCONTINUOUS: () => '命令方块链不连续',

  FORCED_INVALID_CONFIG: () => '强制合并要求有效的 TPS、电路层坐标和主线间距',
  FORCED_SUPPORT_LAYER: () => '强制合并要求支撑层位于电路层正下方',
  FORCED_INVALID_NOTE_TIME: () => '强制合并音符时间必须是非负整数游戏刻',
  FORCED_BRANCH_TOO_DEEP: (d) =>
    `强制合并峰值 ${value(d, 'peakNotes')} 音需要 ${value(d, 'branchDelay')} 红石刻同步补偿，` +
    `主线需 ${value(d, 'mainRun')} 格连续红石粉，超过安全预算 ${value(d, 'maxPadRun')}；未生成投影`,
  FORCED_SUPPORT_IS_AIR: () => '强制合并的红石粉和中继器支撑方块不能为空气',
  FORCED_COORDINATE_CONFLICT: (d) => `强制合并电路坐标冲突：${value(d, 'position')}`,

  FORCED_VALIDATION_BLOCK_OVERLAP: (d) => `强制合并校验：方块重叠 ${value(d, 'position')}`,
  FORCED_VALIDATION_TAP_MISMATCH: () => '强制合并校验：音群时刻数不一致',
  FORCED_VALIDATION_MISSING_SUPPORT: (d) => `强制合并校验：缺少支撑方块 ${value(d, 'position')}`,
  FORCED_VALIDATION_UNREGISTERED_NOTE: (d) => `强制合并校验：未登记音符盒 ${value(d, 'position')}`,
  FORCED_VALIDATION_BAD_REPEATER: (d) => `强制合并校验：无效中继器状态 ${value(d, 'position')}`,
  FORCED_VALIDATION_REPEATER_LOCKED: (d) => `强制合并校验：中继器可能被侧向锁定 ${value(d, 'position')}`,
  FORCED_VALIDATION_NO_ENTRY: () => '强制合并校验：缺少单主线接电入口',
  FORCED_VALIDATION_UNREACHABLE: (d) =>
    `强制合并校验：信号无法到达 ${value(d, 'block')} (${value(d, 'position')})`,
  FORCED_VALIDATION_WRONG_TICK: (d) =>
    `强制合并校验：音符盒 (${value(d, 'position')}) 实际 ${value(d, 'actual')} 游戏刻，` +
    `期望 ${value(d, 'expected')}`,

  PALETTE_EMPTY: () => '音色板为空：没有任何可用的音区',

  NBT_STRING_TOO_LONG: (d) => `NBT 字符串过长：${value(d, 'bytes')} bytes`,
  NBT_READ_OUT_OF_BOUNDS: (d) =>
    `NBT 越界读取: pos=${value(d, 'position')} need=${value(d, 'need')} len=${value(d, 'length')}`,
  NBT_UNREADABLE_END_TAG: () => '无法读取 End 标签的负载',
  NBT_UNKNOWN_TAG_TYPE: (d) => `未知标签类型 ${value(d, 'type')}`,

  LITEMATIC_ENTITY_OUT_OF_BOUNDS: () => '方块实体坐标越界',
  LITEMATIC_ENTITY_WITHOUT_BLOCK: () => '方块实体缺少对应方块',
  LITEMATIC_DUPLICATE_ENTITY: () => '方块实体坐标重复',
  LITEMATIC_BLOCK_OUT_OF_BOUNDS: (d) =>
    `方块坐标越界: (${value(d, 'x')},${value(d, 'y')},${value(d, 'z')}) ` +
    `尺寸 (${value(d, 'sizeX')},${value(d, 'sizeY')},${value(d, 'sizeZ')})`,
  LITEMATIC_MISSING_INT: (d) => `缺少 Int 标签 ${value(d, 'key')}`,
  LITEMATIC_MISSING_COMPOUND: (d) => `缺少 Compound 标签 ${value(d, 'key')}`,
  LITEMATIC_ROOT_NOT_COMPOUND: () => '根标签不是 Compound',
  LITEMATIC_MISSING_METADATA: () => '缺少 Metadata',
  LITEMATIC_MISSING_REGIONS: () => '缺少 Regions',
  LITEMATIC_MISSING_PALETTE: () => '缺少 BlockStatePalette',
  LITEMATIC_BAD_PALETTE_ENTRY: () => '调色板条目不是 Compound',
  LITEMATIC_MISSING_BLOCK_STATES: () => '缺少 BlockStates',
};

/**
 * A readable message for anything the core throws.
 *
 * Non-core failures (a missing file, a malformed MIDI) keep their own message, so
 * nothing is swallowed.
 */
export function describeCoreError(error: unknown): string {
  if (error instanceof CoreError) {
    const render = CORE_ERROR_TEXT[error.code];
    return render ? render(error.details) : error.code;
  }
  return error instanceof Error ? error.message : String(error);
}
