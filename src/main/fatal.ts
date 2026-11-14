/** Side effects for a fatal main-process exception, injected so the policy can be tested. */
export interface FatalActions {
  notify: (line: string) => void;
  showError: (title: string, content: string) => void;
  exit: (code: number) => void;
}

/** Report a fatal exception, then terminate instead of continuing with unknown state. */
export function handleFatalException(error: unknown, actions: FatalActions): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  actions.notify(`[主进程异常] ${error instanceof Error ? error.message : message}`);
  try {
    actions.showError('MusicboxMC 主进程异常', `应用将退出以避免继续在未知状态下运行。\n\n${message}`);
  } catch {
    // The dialog is best-effort; termination still has to happen.
  } finally {
    actions.exit(1);
  }
}
