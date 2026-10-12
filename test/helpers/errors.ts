import { expect } from 'vitest';
import { CoreError, type CoreErrorCode } from '../../src/core/errors';

/**
 * Assert that a call fails with a specific core error.
 *
 * The core raises stable codes rather than sentences, so the engine carries no UI
 * copy and these tests do not break when the wording changes. They also pin down
 * *which* failure occurred, which a substring match on a message never did.
 */
export function expectCoreError(run: () => unknown, code: CoreErrorCode): CoreError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught, `expected ${code}, but nothing was thrown`).toBeInstanceOf(CoreError);
  const core = caught as CoreError;
  expect(core.code).toBe(code);
  return core;
}
