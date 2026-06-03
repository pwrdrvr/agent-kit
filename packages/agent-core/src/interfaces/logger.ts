// The host injects a logger; the kit never imports a concrete logging backend.
// (PwrSnap/PwrAgnt transport files used `getMainLogger` directly — this is the
// seam that replaces it.)

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** A no-op logger for tests or when the host supplies none. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};
