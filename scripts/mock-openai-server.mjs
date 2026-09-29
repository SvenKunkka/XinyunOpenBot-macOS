// Local mock OpenAI-compatible endpoint for END-TO-END testing of the
// "自定义 Base URL + API Key" chat path through the installed app.
//
// This is a TEST FIXTURE, not a provider: it lets us prove that streaming,
// stop-generation, auth errors and persistence really work against the
// packaged app without needing (or touching) any real API credential.
//
//   node scripts/mock-openai-server.mjs [port]
//
// Behaviour:
//   GET  /v1/models                 -> a small model catalog
//   POST /v1/chat/completions
//     - Authorization must be "Bearer test-key-123"; otherwise 401
//     - body.stream === true  -> SSE deltas, one token every 60ms
//     - a prompt containing "SLOW" streams 60 tokens (for stop-generation)
//     - a prompt containing "BOOM" returns a 500
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8899);
const KEY = "test-key-123";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function replyText(prompt) {
  if (prompt.includes("BOOM")) return null;
  if (prompt.includes("SLOW")) {
    return Array.from({ length: 60 }, (_, i) => `块${i + 1} `).join("");
  }
  return "你好！这是来自本地模拟接口的真实流式回复，用于验证 API 聊天链路。";
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return json(res, 401, { error: { message: "invalid api key" } });
    }
    return json(res, 200, {
      object: "list",
      data: [
        { id: "mock-chat-pro", object: "model" },
        { id: "mock-chat-mini", object: "model" },
      ],
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        return json(res, 401, { error: { message: "invalid api key" } });
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const prompt = msgs.map((m) => String(m.content ?? "")).join("\n");
      const text = replyText(prompt);
      if (text === null) {
        return json(res, 500, { error: { message: "mock upstream failure" } });
      }

      if (!body.stream) {
        return json(res, 200, {
          id: "chatcmpl-mock",
          object: "chat.completion",
          model: body.model ?? "mock-chat-pro",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunks = String(text).match(/[\s\S]{1,6}/g) ?? [];
      let i = 0;
      let closed = false;
      // If the client aborts (stop-generation), stop emitting immediately —
      // this makes the abort path observable in the fixture's own log.
      res.on("close", () => {
        closed = true;
        console.log(`[mock] client aborted after ${i}/${chunks.length} chunks`);
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        model: body.model ?? "mock-chat-pro",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      const timer = setInterval(() => {
        if (closed) return clearInterval(timer);
        if (i >= chunks.length) {
          clearInterval(timer);
          send({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: chunks.length, total_tokens: 10 + chunks.length },
          });
          res.write("data: [DONE]\n\n");
          res.end();
          console.log(`[mock] completed ${chunks.length} chunks`);
          return;
        }
        send({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          model: body.model ?? "mock-chat-pro",
          choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
        });
        i++;
      }, 60);
    });
    return;
  }

  json(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] OpenAI-compatible test endpoint on http://127.0.0.1:${PORT}/v1 (key: ${KEY})`);
});
