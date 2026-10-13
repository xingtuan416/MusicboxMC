/**
 * Structured failures for the core.
 *
 * The core is pure logic: it knows how to build a circuit or a schematic, and it
 * has no opinion about what language the user reads. Before this module it threw
 * Chinese sentences, which meant the engine carried UI copy and the tests ended up
 * asserting on wording.
 *
 * Every failure now carries a stable `code` plus the values needed to explain it.
 * `src/main/messages.ts` turns those into prose.
 */

export type CoreErrorCode =
  // Command playback
  | 'COMMAND_INVALID_TPS'
  | 'COMMAND_INVALID_BUDGET'
  | 'COMMAND_INVALID_TRANSPOSE'
  | 'COMMAND_TIME_OUT_OF_RANGE'
  | 'COMMAND_NO_NOTES'
  | 'COMMAND_CHAIN_TOO_LONG'
  | 'COMMAND_CHAIN_DISCONTINUOUS'
  // Forced merge
  | 'FORCED_INVALID_CONFIG'
  | 'FORCED_SUPPORT_LAYER'
  | 'FORCED_INVALID_NOTE_TIME'
  | 'FORCED_BRANCH_TOO_DEEP'
  | 'FORCED_SUPPORT_IS_AIR'
  | 'FORCED_COORDINATE_CONFLICT'
  // Forced-merge validation of the produced block graph
  | 'FORCED_VALIDATION_BLOCK_OVERLAP'
  | 'FORCED_VALIDATION_TAP_MISMATCH'
  | 'FORCED_VALIDATION_MISSING_SUPPORT'
  | 'FORCED_VALIDATION_UNREGISTERED_NOTE'
  | 'FORCED_VALIDATION_BAD_REPEATER'
  | 'FORCED_VALIDATION_REPEATER_LOCKED'
  | 'FORCED_VALIDATION_NO_ENTRY'
  | 'FORCED_VALIDATION_UNREACHABLE'
  | 'FORCED_VALIDATION_WRONG_TICK'
  // MIDI parsing and timing
  | 'MIDI_UNSUPPORTED_TIMEBASE'
  | 'MIDI_INVALID_TIMING'
  | 'LAYOUT_INVALID_CONFIG'
  | 'LAYOUT_INVALID_TICK'
  // Palette
  | 'PALETTE_EMPTY'
  // NBT codec
  | 'NBT_STRING_TOO_LONG'
  | 'NBT_INVALID_UTF8'
  | 'NBT_READ_OUT_OF_BOUNDS'
  | 'NBT_UNREADABLE_END_TAG'
  | 'NBT_UNKNOWN_TAG_TYPE'
  // Litematic packing
  | 'LITEMATIC_ENTITY_OUT_OF_BOUNDS'
  | 'LITEMATIC_ENTITY_WITHOUT_BLOCK'
  | 'LITEMATIC_DUPLICATE_ENTITY'
  | 'LITEMATIC_BLOCK_OUT_OF_BOUNDS'
  | 'LITEMATIC_MISSING_INT'
  | 'LITEMATIC_MISSING_COMPOUND'
  | 'LITEMATIC_ROOT_NOT_COMPOUND'
  | 'LITEMATIC_MISSING_METADATA'
  | 'LITEMATIC_MISSING_REGIONS'
  | 'LITEMATIC_MISSING_PALETTE'
  | 'LITEMATIC_BAD_PALETTE_ENTRY'
  | 'LITEMATIC_MISSING_BLOCK_STATES';

/** Values interpolated into a failure's explanation. */
export type CoreErrorDetails = Readonly<Record<string, string | number>>;

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    readonly details: CoreErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    // Deliberately machine-readable rather than user-facing: this text exists so
    // logs and stack traces identify the failure, nothing more.
    const suffix = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
    super(`${code}${suffix}`, options);
    this.name = 'CoreError';
  }
}

export function coreError(
  code: CoreErrorCode,
  details?: CoreErrorDetails,
  options?: { cause?: unknown },
): CoreError {
  return new CoreError(code, details, options);
}
