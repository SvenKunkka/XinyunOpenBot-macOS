// Compiles the optional macOS speech helper (electron/resources/speech-helper).
//
// IMPORTANT — this helper is currently NOT WIRED UP. The renderer records with
// MediaRecorder and sends audio to the server's STT endpoints
// (src/lib/voice/recorder.ts -> /api/voice/*); nothing calls the preload's
// speechStart()/onSpeechTranscript() bridge. The Swift binary is dead code kept
// for a future on-device dictation path, so a failure to build it must NOT
// break `pnpm package`.
//
// It is also frequently unbuildable on machines with only the Command Line
// Tools: Apple's CLT has shipped a stale duplicate modulemap for years
// (/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap,
// byte-identical to bridging.modulemap), which makes ANY framework import fail
// with "redefinition of module 'SwiftBridging'". Installing full Xcode, or
// deleting that one stale file, fixes it.
//
// Behaviour:
//   - builds the helper when the toolchain works, then ad-hoc signs it in place
//   - on failure, prints a precise explanation and exits 0 (skip, not abort)
//   - set OMB_REQUIRE_SPEECH_HELPER=1 to turn the skip into a hard failure
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "electron", "resources", "speech-helper.swift");
const OUT = path.join(root, "electron", "resources", "speech-helper");
const BIN_DIR = path.join(root, "electron", "resources");

function skip(reason, detail) {
  console.warn(`\n[build:speech] 跳过语音辅助程序构建：${reason}`);
  if (detail) console.warn(detail.trim().split("\n").slice(0, 6).join("\n"));
  console.warn(
    "[build:speech] 这是可选的、当前未接入的功能，不影响应用打包与语音输入。\n" +
      "[build:speech] 语音输入走 MediaRecorder + 服务端 STT，与本辅助程序无关。\n",
  );
  if (process.env.OMB_REQUIRE_SPEECH_HELPER === "1") process.exit(1);
  process.exit(0);
}

if (process.platform !== "darwin") skip(`当前平台为 ${process.platform}，仅 macOS 需要`);

try {
  execFileSync("swiftc", ["--version"], { stdio: "pipe" });
} catch {
  skip("未找到 swiftc 编译器（需要 Xcode 或 Command Line Tools）");
}

try {
  execFileSync("swiftc", ["-O", SRC, "-o", OUT], { stdio: "pipe", timeout: 180_000 });
} catch (err) {
  const output = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
  const modulemap = /redefinition of module 'SwiftBridging'/.test(output);
  skip(
    modulemap
      ? "本机 Command Line Tools 存在已知的旧版 modulemap 冲突"
      : "swiftc 编译失败",
    modulemap
      ? "\n原因：/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap 与\n" +
          "      bridging.modulemap 重复定义了 SwiftBridging 模块（Apple CLT 遗留文件）。\n" +
          "修复：安装完整 Xcode，或删除上面那个陈旧的 module.modulemap 文件。"
      : output,
  );
}

// The helper is spawned by the app, so an unsigned binary is killed by
// Gatekeeper on macOS 15+. Ad-hoc sign it in place.
try {
  execFileSync("codesign", ["--force", "--sign", "-", OUT], { stdio: "pipe" });
} catch {
  console.warn("[build:speech] 警告：ad-hoc 签名失败，辅助程序可能无法运行。");
}

mkdirSync(BIN_DIR, { recursive: true });
console.log(`[build:speech] 已生成 ${path.relative(root, OUT)} (${existsSync(OUT) ? "ok" : "缺失"})`);
