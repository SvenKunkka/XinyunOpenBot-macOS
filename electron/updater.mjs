// In-app auto-updater (electron-updater), manual/button-driven — the same
// shape t3code's desktop app uses: autoDownload off, quitAndInstall on the
// user's "Restart to update" click. One state object is broadcast to the
// renderer on every transition; the renderer just renders it.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | error
let state = { status: "idle" };
let updaterCoordinator = null;

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => {
    // isSilent, isForceRunAfter — relaunch straight into the new version
    try {
      autoUpdater?.quitAndInstall(true, true);
    } catch (e) {
      setState({ status: "error", message: String(e?.message ?? e) });
    }
  });
}

// Local/dev builds must never be replaced by an upstream release. The
// packaged app ships app-update.yml pointing at the PUBLIC upstream repo
// (dongpen-max/xinyunopenbot-releases), so on a locally-built copy a plain
// "check for updates" would offer to install upstream's build over ours —
// silently swapping a locally verified binary for an unverified one.
//
// Auto-download and auto-install were already off (button-driven), but the
// periodic check still surfaced an actionable "update available" banner. So
// the whole updater is now OPT-IN: it stays dormant unless this exact build
// was explicitly marked as an official release build.
//
// Enable for a real release by setting either:
//   - env  OMB_ENABLE_UPDATER=1            (ad-hoc testing)
//   - file <Resources>/updater-enabled     (baked in at release time)
// Keeps the future path to a real update feed intact: point `publish` in
// electron-builder.yml at the official repo/draft and ship the marker file.
function updaterEnabled() {
  if (process.env.OMB_ENABLE_UPDATER === "1") return true;
  try {
    return fs.existsSync(path.join(process.resourcesPath, "updater-enabled"));
  } catch {
    return false;
  }
}

export function startUpdater(mainWindow) {
  win = mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  if (!updaterEnabled()) {
    // Disabled (the default for local builds): no check, no banner, and the
    // IPC handlers stay no-ops so a stray click can't reach the network.
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  autoUpdater.autoInstallOnAppQuit = false; // button-driven install
  autoUpdater.logger = null;

  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState);

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
