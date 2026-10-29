import { desktop } from './desktop';

const KEY = 'friday.notifications';

export type NotificationState = 'unsupported' | 'blocked' | 'off' | 'on';

function readPref(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writePref(value: 'on' | 'off'): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/** On by default in the desktop app; in a browser, only after the user turns it on. */
export function notificationState(): NotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const pref = readPref() ?? (desktop ? 'on' : 'off');
  return pref === 'on' && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Must be called from a user gesture (browsers only show the permission prompt then). */
export async function enableNotifications(): Promise<NotificationState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission === 'granted') writePref('on');
  return notificationState();
}

export function disableNotifications(): void {
  writePref('off');
}

/** Show a system notification; clicking it brings Friday to the front and runs `onClick`. */
export function notify(opts: { title: string; body: string; tag: string; onClick?: () => void }) {
  if (notificationState() !== 'on') return;
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
    n.onclick = () => {
      if (desktop) void desktop.focusWindow();
      else window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    // Some platforms refuse notifications from pages; the in-app state still shows everything.
  }
}
