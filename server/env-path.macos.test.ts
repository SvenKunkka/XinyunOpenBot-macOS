// macOS GUI-launch PATH contract (issues #8, #12): a Finder-launched app
// inherits a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so augmentedPath()
// — not the inherited PATH — is what has to make the agent CLIs visible.
//
// These tests are hermetic: setup.ts repoints HOME at a temp dir, and every
// assertion about a *real* macOS install location is guarded by an
// existsSync() check, so the file degrades to the platform-neutral checks
// on CI (Linux/Windows) instead of failing.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { augmentedPath, resetPathCache, resetPathCacheForTests } from "./env-path.ts";

const macIt = it.skipIf(process.platform !== "darwin");

/** The dirs a macOS GUI launch is missing but the login shell exports.
 * Asserted only when they exist, so no machine's layout is assumed. */
const macInstallDirs = [
  "/opt/homebrew/bin", // brew, Apple silicon
  "/usr/local/bin", // brew Intel / classic installs
  "/opt/local/bin", // MacPorts
  join(homedir(), "Library", "pnpm", "bin"), // pnpm globalBinDir (macOS default)
  join(homedir(), ".local", "bin"), // claude installer default
  join(homedir(), ".claude", "local"), // claude "local install"
  join(homedir(), ".volta", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".asdf", "shims"),
  join(homedir(), ".deno", "bin"),
  join(homedir(), "bin"),
];

describe("augmentedPath on macOS", () => {
  const originalPath = process.env.PATH;
  const originalExtra = process.env.OMB_EXTRA_PATH;

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalExtra === undefined) delete process.env.OMB_EXTRA_PATH;
    else process.env.OMB_EXTRA_PATH = originalExtra;
    resetPathCacheForTests();
  });

  it("produces a well-formed PATH: no empty entries", () => {
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    expect(parts.length).toBeGreaterThan(0);
    // mergePaths() filters empties, so `::` must never survive — an empty
    // entry means the CWD on POSIX, which is both wrong and a security hole
    expect(parts.filter((p) => p === "")).toHaveLength(0);
    for (const p of parts) expect(p.trim()).toBe(p);
  });

  it("dedupes entries so a bare GUI PATH cannot shadow or repeat", () => {
    // the real Finder PATH, plus a duplicate of one of its own entries
    process.env.PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/bin"].join(delimiter);
    resetPathCacheForTests();

    const parts = augmentedPath().split(delimiter);
    expect(new Set(parts).size).toBe(parts.length);
    // inherited entries stay first, so the GUI PATH keeps its precedence
    expect(parts[0]).toBe("/usr/bin");
  });

  macIt("folds in the macOS install dirs that the bare GUI PATH lacks", () => {
    const bare = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
    process.env.PATH = bare;
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);

    // /opt/homebrew/bin is where the CLIs live on Apple silicon. Skip
    // (don't fail) when brew isn't installed — e.g. Linux CI, or a Mac
    // that only ever used the native installers.
    if (!existsSync("/opt/homebrew/bin")) return;
    expect(parts).toContain("/opt/homebrew/bin");
    // the bare GUI PATH never had it, so this is augmentation, not inheritance
    expect(bare.split(delimiter)).not.toContain("/opt/homebrew/bin");
  });

  macIt("includes every known install dir that actually exists", () => {
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    const present = macInstallDirs.filter((d) => existsSync(d));

    // at least one must exist or the assertion below is vacuous
    expect(present.length).toBeGreaterThan(0);
    // pnpm's macOS global bin dir is only on PATH here via knownDirs()
    for (const dir of present) expect(parts).toContain(dir);
  });

  macIt("omits install dirs that do not exist on this machine", () => {
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    for (const dir of macInstallDirs.filter((d) => !existsSync(d))) {
      expect(parts).not.toContain(dir);
    }
  });
});

// Platform-neutral (every runner needs it), but it lives here because the
// macOS GUI flow is what makes a stale cache user-visible: "check again"
// after installing a CLI must not answer from the PATH we booted with.
describe("path cache reset", () => {
  afterEach(() => {
    resetPathCacheForTests();
  });

  it("resetPathCache() forces a rescan of the inherited PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    resetPathCacheForTests();
    const first = augmentedPath();
    expect(first.split(delimiter)[0]).toBe("/usr/bin");

    // mutate PATH without resetting: the memoized value must be served
    process.env.PATH = "/sbin:/usr/sbin";
    expect(augmentedPath()).toBe(first);

    // resetPathCache() is the public "check again" hook
    resetPathCache();
    const rescanned = augmentedPath();
    expect(rescanned.split(delimiter)[0]).toBe("/sbin");
    expect(rescanned).not.toBe(first);
  });

  it("resetPathCacheForTests() re-derives from process.env, idempotently", () => {
    process.env.PATH = "/usr/bin:/bin";
    resetPathCacheForTests();
    const first = augmentedPath();

    // VITEST is set under vitest, so no login-shell probe runs; the hook
    // must leave the derived value stable rather than accumulate state
    resetPathCacheForTests();
    const again = augmentedPath();
    expect(again.split(delimiter)).toContain("/usr/bin");
    expect(again).toBe(first);
  });

  it("resetPathCache() picks up a dir that appears after the first call", () => {
    process.env.PATH = "/usr/bin:/bin";
    resetPathCacheForTests();
    expect(augmentedPath().split(delimiter)).toContain("/usr/bin");

    // a CLI installed while the app is running is exactly the case the
    // reset hook exists for: same env, but the entry is now meaningful
    process.env.OMB_EXTRA_PATH = "/tmp/omb-macos-extra";
    resetPathCache();
    expect(augmentedPath().split(delimiter)[0]).toBe("/tmp/omb-macos-extra");
  });
});
