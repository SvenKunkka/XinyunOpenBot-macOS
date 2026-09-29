// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
// Runs until the final result or SIGTERM. Spawned by electron/speech.mjs
// from the MAIN process so mic + speech TCC prompts attribute to the app.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
    fflush(stdout)
  }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

// Locale selection. This app is Simplified-Chinese first, so a hardcoded
// en-US recognizer transcribes Chinese speech badly or not at all. Prefer an
// explicit locale from the caller (argv[1], e.g. "zh-CN"), then the system's
// preferred language, then zh-CN — never a hardcoded English default.
func resolveLocale() -> Locale {
  if CommandLine.arguments.count > 1 {
    let arg = CommandLine.arguments[1].trimmingCharacters(in: .whitespaces)
    if !arg.isEmpty, let r = SFSpeechRecognizer(locale: Locale(identifier: arg)) {
      return r.locale
    }
  }
  let preferred = Locale.preferredLanguages.first ?? "zh-CN"
  if let r = SFSpeechRecognizer(locale: Locale(identifier: preferred)) {
    return r.locale
  }
  return Locale(identifier: "zh-CN")
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { fail("speech-not-authorized") }
  guard let recognizer = SFSpeechRecognizer(locale: resolveLocale()),
    recognizer.isAvailable
  else { fail("recognizer-unavailable") }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      emit(["partial": !result.isFinal, "text": result.bestTranscription.formattedString])
      if result.isFinal { exit(0) }
    }
    if error != nil { fail("recognition-error") }
  }
}

RunLoop.main.run()
