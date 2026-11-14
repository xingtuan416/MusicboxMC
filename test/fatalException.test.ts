import { describe, expect, it, vi } from 'vitest';
import { handleFatalException } from '../src/main/fatal';

describe('fatal main-process exceptions', () => {
  it('reports the failure and exits instead of continuing', () => {
    const notify = vi.fn();
    const showError = vi.fn();
    const exit = vi.fn();
    const error = new Error('layout state corrupted');

    handleFatalException(error, { notify, showError, exit });

    expect(notify).toHaveBeenCalledWith('[主进程异常] layout state corrupted');
    expect(showError).toHaveBeenCalledWith(
      'MusicboxMC 主进程异常',
      expect.stringContaining('layout state corrupted'),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits when the error dialog itself fails', () => {
    const exit = vi.fn();
    const showError = vi.fn(() => {
      throw new Error('no display');
    });

    expect(() =>
      handleFatalException(new Error('boom'), {
        notify: vi.fn(),
        showError,
        exit,
      }),
    ).not.toThrow();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
