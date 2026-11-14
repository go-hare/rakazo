import type { DesktopSetup } from "@rakazo/contracts";
import type { BrowserWindow } from "electron";
import type { DesktopUpdateController } from "./auto-update.js";
import type { createDesktopDaemon } from "./daemon-launch.js";
import type { LocalStackController } from "./local-stack.js";
import type { UserDeviceAccess } from "./user-device.js";

/** Window, setup, and service state shared by the main process modules. */
export const desktop = {
  mainWindow: null,
  setupWindow: null,
  currentSetup: null,
  currentTargetUrl: null,
  setupError: null,
  quitting: false,
  warmWindowTimer: undefined,
  // Number of short-lived hidden probe windows currently alive. On Windows/Linux,
  // destroying the last window fires "window-all-closed" -> app.quit(); a probe
  // that runs before the first real window exists must not count as "all closed".
  liveProbeWindows: 0,
  launchUpdateCheckScheduled: false,
  hostComputer: undefined,
  userDevices: undefined,
  daemon: undefined,
  refreshDaemon: undefined,
} as {
  mainWindow: BrowserWindow | null;
  setupWindow: BrowserWindow | null;
  currentSetup: DesktopSetup | null;
  currentTargetUrl: string | null;
  setupError: string | null;
  quitting: boolean;
  warmWindowTimer: NodeJS.Timeout | undefined;
  liveProbeWindows: number;
  /** Created once the app's language is known, so its first message is in it. */
  desktopUpdater: DesktopUpdateController;
  launchUpdateCheckScheduled: boolean;
  localStack: LocalStackController;
  hostComputer:
    | {
        connection: { url: string; token: string };
        isEnabled: () => boolean;
        activate: (value: boolean) => void;
        grant: () => Promise<void>;
        revoke: () => Promise<void>;
        close: () => Promise<void>;
      }
    | undefined;
  userDevices: UserDeviceAccess | undefined;
  daemon: ReturnType<typeof createDesktopDaemon> | undefined;
  refreshDaemon: (() => void) | undefined;
};

export const appWindowTargets = new WeakMap<BrowserWindow, string>();
