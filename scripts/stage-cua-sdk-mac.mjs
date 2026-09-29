// Stage the CUA (computer-use) runtime so a PACKAGED app can start its own
// embedded cua-driver daemon.
//
// Why this is needed at all: electron-builder deliberately excludes
// node_modules from the app archive, and `electron/cua.mjs` imports
// `@trycua/cua-driver/embedded` — so on every packaged build that import
// threw ("Cannot find package '@trycua/cua-driver'") and computer use
// silently degraded to mode:"unavailable". The Windows packaging script
// already staged a copy (scripts/stage-cua-sdk.mjs, win64 only); this script
// generalizes it to the host platform so macOS gets the same treatment.
//
// Layout: dist-server/ is copied verbatim to Resources/server, so staging
// under dist-server/cua-sdk lands at Resources/server/cua-sdk. The literal
// `node_modules` segment is avoided on purpose — electron-builder filters
// node_modules below extraResources, which would silently drop it.
//
// The SDK imports `@ubjs/core` / `@ubjs/node` by bare specifier, so those are
// staged too and the imports are rewritten to relative paths. The platform
// resolver is replaced with a fixed sibling path, which is what makes the
// copied runtime independent of any node_modules lookup.
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = join(root, "dist-server", "cua-sdk");
const target = join(stageRoot, "packages");
const pnpmRoot = join(root, "node_modules", ".pnpm");
const entries = await readdir(pnpmRoot);

// ── platform selection ────────────────────────────────────────────────
// The native sibling must match the HOST arch we are packaging for, not the
// machine running the script (electron-builder can target another arch).
const arch = process.env.npm_config_arch || process.env.OMB_TARGET_ARCH || process.arch;
const platformPackages = {
  darwin: { arm64: "@trycua/cua-driver-darwin-arm64", x64: "@trycua/cua-driver-darwin-x64" },
  win32: {
    arm64: "@trycua/cua-driver-win32-arm64-msvc",
    x64: "@trycua/cua-driver-win32-x64-msvc",
  },
  linux: {
    arm64: "@trycua/cua-driver-linux-arm64-gnu",
    x64: "@trycua/cua-driver-linux-x64-gnu",
  },
};
const nativePackage = platformPackages[process.platform]?.[arch];
if (!nativePackage) {
  console.error(`[cua] no cua-driver native package known for ${process.platform}/${arch} — skipping`);
  process.exit(0);
}

async function packageRoot(specifier) {
  for (const entry of entries) {
    try {
      return await realpath(join(pnpmRoot, entry, "node_modules", ...specifier.split("/")));
    } catch {
      // The pnpm store holds many unrelated package folders.
    }
  }
  throw new Error(`missing CUA runtime package: ${specifier}`);
}

const packages = ["@trycua/cua-driver", nativePackage, "@ubjs/core", "@ubjs/node"];
// The @ubjs native binary is per-platform too; stage it when it exists.
const ubjsNative = {
  darwin: `@ubjs/node-darwin-${arch === "arm64" ? "arm64" : "x64"}`,
  win32: `@ubjs/node-win32-${arch}-msvc`,
  linux: `@ubjs/node-linux-${arch}-gnu`,
}[process.platform];
if (ubjsNative) packages.push(ubjsNative);

await rm(stageRoot, { recursive: true, force: true });
for (const name of packages) {
  try {
    const source = await packageRoot(name);
    const destination = join(target, ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: true });
  } catch (err) {
    // An optional platform binary may simply not be installed; the SDK only
    // needs the one matching the packaging target.
    if (name === ubjsNative) console.warn(`[cua] optional ${name} not staged: ${err.message}`);
    else throw err;
  }
}

const cuaDriver = join(target, "@trycua", "cua-driver");

// The SDK imports a couple of packages by bare name. Repoint them at the
// colocated staged copies so no node_modules resolution is required. The
// relative depth differs per file (dist/*.js vs dist/native/*.js) and
// @ubjs/node is imported through a SUBPATH, so match the specifier prefix
// rather than the bare package name alone.
const UBJS_DIRS = {
  "@ubjs/core": ["dist", "esm", "index.js"],
  "@ubjs/node": ["dist", "esm", "index.js"],
};
function repointBareImports(source, upLevels) {
  let out = source;
  for (const [specifier, rest] of Object.entries(UBJS_DIRS)) {
    const up = "../".repeat(upLevels);
    // Any subpath of the package (e.g. /typescript/dist/resolve-lib.js) keeps
    // its subpath; only the package name is redirected.
    const pattern = new RegExp(`(["'])${specifier.replace("/", "\\/")}((?:\\/[^"']*)?)\\1`, "g");
    out = out.replace(pattern, (_m, quote, subpath) => {
      const target = subpath ? subpath.slice(1) : rest.join("/");
      return `${quote}${up}@ubjs/${specifier.split("/")[1]}/${target}${quote}`;
    });
  }
  return out;
}

for (const relDir of ["dist", join("dist", "native")]) {
  const dir = join(cuaDriver, relDir);
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    continue;
  }
  // Depth from this file up to cua-sdk/packages/:
  //   packages/@trycua/cua-driver/dist/<file>        -> 3 up
  //   packages/@trycua/cua-driver/dist/native/<file> -> 4 up
  const upLevels = relDir.split(sep).length + 2;
  for (const entry of files) {
    if (!entry.endsWith(".js")) continue;
    const file = join(dir, entry);
    const source = await readFile(file, "utf8");
    const patched = repointBareImports(source, upLevels);
    if (patched !== source) await writeFile(file, patched);
  }
}

// The native library is located by the `*-ffi.js` files, which call
// resolveLibPath({ npmPackageBase: "@trycua/cua-driver-" }). That resolves the
// platform package through createRequire(...).resolve(), i.e. a node_modules
// lookup that can never succeed in a packaged app (electron-builder strips
// node_modules). Swap in the resolver's explicit `override` mode, pointing at
// the staged sibling, so the SDK's real resolveLibPath + UniffiNativeModule
// stay intact (hand-writing a stub instead breaks the Rust call with
// "Failed to convert JavaScript value `Null` into rust type `String`").
const nativeDir = join(cuaDriver, "dist", "native");
const nativeSiblingName = nativePackage.split("/")[1];
const nativeSibling = join(dirname(cuaDriver), nativeSiblingName);
if (!existsSync(nativeSibling)) {
  throw new Error(`cua staging: native package missing at ${nativeSibling}`);
}
const libFileName =
  process.platform === "win32" ? "cua_driver_sdk.dll" : "libcua_driver_sdk.dylib";

// Also rewrite node-runtime.js so its OWN resolveLibPath call (used by any
// consumer that imports it directly) uses the override.
const runtimeFile = join(nativeDir, "node-runtime.js");
const runtimeSource = await readFile(runtimeFile, "utf8");
const patchedRuntime = runtimeSource.replace(
  /const sdkLibrary = resolveLibPath\(\{[\s\S]*?\}\);/,
  `const sdkLibrary = resolveLibPath({\n` +
    `    crateName: "cua_driver_sdk",\n` +
    `    callerUrl: import.meta.url,\n` +
    `    override: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ${JSON.stringify(nativeSiblingName)}, ${JSON.stringify(libFileName)}),\n` +
    `});`,
);
if (patchedRuntime === runtimeSource) {
  throw new Error("cua staging: could not rewrite resolveLibPath in node-runtime.js");
}
await writeFile(runtimeFile, ensureFileUrlImport(patchedRuntime));

// The files that actually open the native module.
const ffiFiles = (await readdir(nativeDir)).filter((f) => f.endsWith("-ffi.js"));
if (!ffiFiles.length) throw new Error(`cua staging: no *-ffi.js found in ${nativeDir}`);
for (const entry of ffiFiles) {
  const file = join(nativeDir, entry);
  const source = await readFile(file, "utf8");
  // depth: dist/native/<file> -> up 3 to reach packages/, then the sibling
  const patched = source.replace(
    /resolveLibPath\(\{[\s\S]*?\}\)/,
    `resolveLibPath({\n` +
      `            crateName: "cua_driver_sdk",\n` +
      `            callerUrl: import.meta.url,\n` +
      `            override: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ${JSON.stringify(nativeSiblingName)}, ${JSON.stringify(libFileName)}),\n` +
      `        })`,
  );
  if (patched === source) {
    throw new Error(`cua staging: could not rewrite resolveLibPath in ${entry}`);
  }
  await writeFile(file, ensureFileUrlImport(patched, { asImport: false }));
}

function ensureFileUrlImport(source, { asImport = true } = {}) {
  const hasImport = /^import\s+\{[^}]*fileURLToPath[^}]*\}\s+from\s+"node:url";/m.test(source);
  const needsJoin = !/^import\s+\{[^}]*\bjoin\b[^}]*\}\s+from\s+"node:path";/m.test(source);
  let out = source;
  if (needsJoin) {
    out = out.replace(
      /^(import .*from "node:path";)$/m,
      `import { dirname, join } from "node:path";\n$1`,
    );
    if (out === source) {
      // no node:path import at all — add one after the first import line
      out = out.replace(/^(import .*;)$/m, `$1\nimport { dirname, join } from "node:path";`);
    }
  }
  if (!hasImport) {
    out = out.replace(
      /^(import .*from "node:path";)$/m,
      `$1\nimport { fileURLToPath } from "node:url";`,
    );
    if (!/^import\s+\{[^}]*fileURLToPath[^}]*\}\s+from\s+"node:url";/m.test(out)) {
      out = out.replace(/^(import .*;)$/m, `$1\nimport { fileURLToPath } from "node:url";`);
    }
  }
  if (!/^import\s+\{[^}]*fileURLToPath[^}]*\}\s+from\s+"node:url";/m.test(out)) {
    throw new Error("cua staging: failed to ensure the fileURLToPath import");
  }
  void asImport;
  return out;
}

console.log(
  `[cua] staged ${packages.length} packages for ${process.platform}/${arch} -> ${target.replace(root + "/", "")}`,
);
