// Platform seams the host injects so the kit stays Electron-free and testable.

/** Time source. Inject a fake in tests; the host uses `systemClock` in prod. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now()
};

/**
 * Opens a URL in the user's browser. Codex login scrapes an OAuth URL and hands
 * it here (the host passes Electron `shell.openExternal`), so the discovery /
 * login flow never imports Electron.
 */
export type OpenExternal = (url: string) => Promise<void>;
