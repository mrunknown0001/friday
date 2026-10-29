/**
 * Bridge exposed by the desktop app's preload script (apps/desktop/src/preload.cts). It is null in
 * the browser. It only offers user-driven actions: no filesystem or shell access.
 */
export interface DesktopBridge {
  /** Native folder picker; resolves to the chosen absolute path, or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** Restart the local server (re-reads the config file), then reload the window. */
  restartServer(): Promise<void>;
  /** Reveal the config file in the system file manager, creating it from a template if missing. */
  showConfigFile(): Promise<void>;
}

export const desktop: DesktopBridge | null =
  (window as { fridayDesktop?: DesktopBridge }).fridayDesktop ?? null;
