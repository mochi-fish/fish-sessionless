// 生成文件，别手改。来源：billion-context（MIT，Copyright (c) 2026 ranxianglei；见 ../../THIRD-PARTY-NOTICES.md）fork 提交 5bb25bfd1e180314343a924b14d0b95d1d3f41ef 的 kernel/src/wire（git archive 只读拷出），esbuild 0.27.7。
// 重新生成：node --import <offline-guard> --import <netguard> fwd/vendor/build-kernel-wire.mjs <billion-context 仓库目录>

// kernel/src/wire/util.ts
import { createHash } from "node:crypto";
function hashId(s) {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

// kernel/src/wire/identity.ts
var CANONICAL_IMAGE_TEXT = "[image]";
var CANONICAL_REDACTED_THINKING_TEXT = "[redacted_thinking]";
function canonicalToolArgs(argsText) {
  const trimmed = argsText.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return argsText;
  try {
    return JSON.stringify(canonicalize(JSON.parse(trimmed)));
  } catch {
    return argsText;
  }
}
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === "object") {
    const src = v;
    const out = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return v;
}
var idSalt = null;
function deriveCanonicalMessageId(role, contentType, text, options = {}) {
  const seed = `${idSalt ? idSalt + "|" : ""}${role}|${contentType}||${options.toolName ?? ""}|${text}` + (options.mediaFingerprint !== void 0 ? `|${options.mediaFingerprint}` : "");
  return "h_" + hashId(seed);
}
function imageMediaFingerprint(base64OrUrl) {
  return hashId(base64OrUrl);
}

// kernel/src/wire/message-id.ts
var ClusterCounter = class {
  counts = /* @__PURE__ */ new Map();
  next(baseId) {
    const n = this.counts.get(baseId) ?? 0;
    this.counts.set(baseId, n + 1);
    return n === 0 ? baseId : `${baseId}_${n}`;
  }
};

// kernel/src/prune.ts
var SUMMARY_ID_PREFIX = "acp_summary_";
function isSummaryMessageId(id) {
  return id.startsWith(SUMMARY_ID_PREFIX);
}

// kernel/src/wire/anthropic.ts
function extractSystem(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}
function anthropicToCore(body) {
  const msgs = [];
  const cacheControls = /* @__PURE__ */ new Map();
  const clusters = new ClusterCounter();
  const toolNames = /* @__PURE__ */ new Map();
  for (const [wireIndex, m] of body.messages.entries()) {
    const before = msgs.length;
    if (m.role === "system") {
      const core = systemMessageCore(m, clusters);
      core.wireIndex = wireIndex;
      msgs.push(core);
      const mark = systemMessageMark(m);
      if (mark) cacheControls.set(core.id, mark);
      continue;
    }
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocks) {
      switch (b.type) {
        case "text": {
          const base = deriveCanonicalMessageId(m.role, "text", b.text);
          const id = clusters.next(base);
          msgs.push({ id, role: m.role, contentType: "text", text: b.text });
          if (b.cache_control) cacheControls.set(id, b.cache_control);
          break;
        }
        case "tool_use": {
          const base = deriveCanonicalMessageId(
            "assistant",
            "tool-call",
            canonicalToolArgs(safeStringify(b.input)),
            { toolName: b.name }
          );
          const id = clusters.next(base);
          msgs.push({
            id,
            role: "assistant",
            contentType: "tool-call",
            toolName: b.name,
            toolCallId: b.id,
            text: safeStringify(b.input)
          });
          toolNames.set(b.id, b.name);
          if (b.cache_control) cacheControls.set(id, b.cache_control);
          break;
        }
        case "tool_result": {
          const hasNonText = Array.isArray(b.content) && b.content.some((c) => c.type !== "text");
          const text = typeof b.content === "string" ? b.content : b.content.map((c) => c.type === "text" ? c.text : "").join("\n");
          const name = toolNames.get(b.tool_use_id);
          const base = deriveCanonicalMessageId("tool", "tool-result", text, {
            toolName: name
          });
          const id = clusters.next(base);
          msgs.push({
            id,
            role: "tool",
            contentType: "tool-result",
            toolCallId: b.tool_use_id,
            text,
            ...name ? { toolName: name } : {},
            ...b.is_error === true ? { toolIsError: true } : {},
            ...hasNonText ? { rawAnthropicBlock: b } : {}
          });
          if (b.cache_control) cacheControls.set(id, b.cache_control);
          break;
        }
        case "thinking": {
          const base = deriveCanonicalMessageId(
            "assistant",
            "reasoning",
            b.thinking
          );
          msgs.push({
            id: clusters.next(base),
            role: "assistant",
            contentType: "reasoning",
            text: b.thinking,
            ...b.signature ? { thinkingSignature: b.signature } : {}
          });
          break;
        }
        case "image": {
          const source = b.source && typeof b.source === "object" && !Array.isArray(b.source) ? b.source : void 0;
          const mediaSidecar = source?.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string" ? {
            imageMediaType: source.media_type,
            imageBase64: source.data
          } : {};
          const base = deriveCanonicalMessageId(m.role, "text", CANONICAL_IMAGE_TEXT, {
            // #3751: payload-addressed ids — base64 source hashes its bytes,
            // URL source degrades to the URL string, unknown shapes keep the
            // shared legacy base.
            mediaFingerprint: source?.type === "base64" && typeof source.data === "string" ? imageMediaFingerprint(source.data) : typeof source?.url === "string" ? imageMediaFingerprint(source.url) : void 0
          });
          msgs.push({
            id: clusters.next(base),
            role: m.role,
            contentType: "text",
            text: CANONICAL_IMAGE_TEXT,
            imagePart: true,
            rawAnthropicBlock: b,
            ...mediaSidecar
          });
          break;
        }
        case "redacted_thinking": {
          const base = deriveCanonicalMessageId(
            m.role,
            "text",
            CANONICAL_REDACTED_THINKING_TEXT
          );
          msgs.push({
            id: clusters.next(base),
            role: m.role,
            contentType: "text",
            text: "[redacted_thinking]",
            rawAnthropicBlock: b
          });
          break;
        }
        default: {
          const unknownType = b.type;
          const label = typeof unknownType === "string" ? `[${unknownType}]` : "[unknown]";
          const base = deriveCanonicalMessageId(m.role, "text", label);
          msgs.push({
            id: clusters.next(base),
            role: m.role,
            contentType: "text",
            text: label,
            rawAnthropicBlock: b
          });
          break;
        }
      }
    }
    for (let k = before; k < msgs.length; k++) {
      msgs[k].wireIndex = wireIndex;
    }
  }
  return { msgs, cacheControls };
}
function systemMessageCore(m, clusters) {
  const label = systemMessageText(m);
  const base = deriveCanonicalMessageId("system", "text", label);
  return {
    id: clusters.next(base),
    role: "system",
    contentType: "text",
    text: label,
    rawAnthropicMessage: m
  };
}
function systemMessageText(m) {
  const text = typeof m.content === "string" ? m.content : m.content.map((b) => b.type === "text" ? b.text : `[${b.type}]`).join("\n");
  return text.length > 0 ? text : "[system]";
}
function systemMessageMark(m) {
  if (typeof m.content === "string") return void 0;
  let mark;
  for (const b of m.content)
    if (b.cache_control) mark = b.cache_control;
  return mark;
}
function safeStringify(v) {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

// kernel/src/wire/google.ts
function normalizeGoogleUserPartOrder(parts) {
  const firstFr = parts.findIndex((p) => p.functionResponse !== void 0);
  if (firstFr === -1) return parts;
  const movable = (p) => typeof p.text === "string" && p.thought !== true && typeof p.thoughtSignature !== "string";
  let reorder = false;
  for (let i = firstFr; i < parts.length; i++) {
    if (movable(parts[i])) {
      reorder = true;
      break;
    }
  }
  if (!reorder) return parts;
  const moved = [];
  const rest = [];
  for (const p of parts) (movable(p) ? moved : rest).push(p);
  return [...moved, ...rest];
}
function coreToGoogle(messages) {
  const out = [];
  let model = null;
  let user = null;
  const flushModel = () => {
    if (!model) return;
    const parts = [...model.reasoning, ...model.text, ...model.calls];
    model = null;
    if (parts.length > 0) out.push({ role: "model", parts });
  };
  const flushUser = () => {
    if (!user) return;
    const parts = normalizeGoogleUserPartOrder([
      ...user.responses,
      ...user.content
    ]);
    user = null;
    if (parts.length > 0) out.push({ role: "user", parts });
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      flushUser();
      if (!model) model = { reasoning: [], text: [], calls: [] };
      if (m.contentType === "reasoning") model.reasoning.push(reasoningPart(m));
      else if (m.contentType === "tool-call") model.calls.push(toolCallPart(m));
      else model.text.push(...contentParts(m));
    } else {
      flushModel();
      if (!user) user = { responses: [], content: [] };
      if (m.role === "tool" || m.contentType === "tool-result")
        user.responses.push(...toolResultParts(m));
      else user.content.push(...contentParts(m));
    }
  }
  flushModel();
  flushUser();
  return out;
}
function injectGoogleSystem(contents, parts) {
  if (parts.length === 0) return contents;
  const extra = parts.join("\n\n");
  const head = contents[0];
  if (head && head.role === "user")
    return [
      { ...head, parts: [{ text: extra }, ...head.parts] },
      ...contents.slice(1)
    ];
  return [{ role: "user", parts: [{ text: extra }] }, ...contents];
}
function reasoningPart(m) {
  const text = m.text ?? "";
  const head = rawParts(m)[0];
  if (head) return { ...head, text, thought: true };
  return {
    text,
    thought: true,
    ...signatureField("thoughtSignature", m.googleThoughtSignature)
  };
}
function toolCallPart(m) {
  const head = rawParts(m)[0];
  if (head && head.functionCall) return head;
  return {
    functionCall: {
      name: m.toolName ?? "unknown",
      args: jsonValue(m.text),
      ...m.toolCallId ? { id: m.toolCallId } : {}
    },
    ...signatureField("thoughtSignature", m.googleThoughtSignature)
  };
}
function toolResultParts(m) {
  const raw = rawParts(m);
  if (raw.length > 0 && raw.every((p) => p.functionResponse)) return raw;
  return [
    {
      functionResponse: {
        name: m.toolName ?? "unknown",
        response: jsonValue(m.text),
        ...m.toolCallId ? { id: m.toolCallId } : {}
      }
    }
  ];
}
function contentParts(m) {
  const text = m.text ?? "";
  const raw = rawParts(m);
  if (raw.length === 0) {
    const parts2 = text && text !== CANONICAL_IMAGE_TEXT && !m.imagePart ? [
      {
        text,
        ...signatureField("thoughtSignature", m.googleThoughtSignature)
      }
    ] : [];
    if (m.imageBase64 && m.imageMediaType)
      parts2.push({
        inlineData: { mimeType: m.imageMediaType, data: m.imageBase64 }
      });
    return parts2;
  }
  const rawTexts = textPartsOf(raw);
  if (rawTexts.map((p) => p.text ?? "").join("\n") === text) return raw;
  const parts = text && text !== CANONICAL_IMAGE_TEXT && !m.imagePart ? [
    {
      text,
      ...signatureField("thoughtSignature", m.googleThoughtSignature)
    }
  ] : [];
  for (const part of raw) {
    if (!rawTexts.includes(part)) parts.push(part);
  }
  return parts;
}
function rawParts(m) {
  const raw = m.rawGoogleParts;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "object" && item !== null) out.push(item);
  }
  return out;
}
function textPartsOf(parts) {
  return parts.filter((p) => typeof p.text === "string" && p.thought !== true);
}
function signatureField(key, signature) {
  return typeof signature === "string" ? { [key]: signature } : {};
}
function jsonValue(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value === null ? {} : value;
  } catch {
    return { output: text };
  }
}

// kernel/src/wire/openai.ts
function coreToOpenai(messages) {
  const out = [];
  let userRun = [];
  const flushUserRun = () => {
    if (userRun.length === 0) return;
    const parts = [];
    let plain = true;
    for (const m of userRun) {
      if (m.rawOpenaiContentParts && m.rawOpenaiContentParts.length > 0) {
        if (m.text) parts.push({ type: "text", text: m.text });
        for (const part of m.rawOpenaiContentParts)
          parts.push(part);
        plain = false;
      } else if (m.rawOpenaiContent) {
        if (m.text && !m.imagePart)
          parts.push({ type: "text", text: m.text });
        parts.push(m.rawOpenaiContent);
        plain = false;
      } else if (m.imageBase64 && m.imageMediaType) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${m.imageMediaType};base64,${m.imageBase64}`
          }
        });
        plain = false;
      } else {
        parts.push({ type: "text", text: m.text ?? "" });
      }
    }
    if (plain && userRun.length === 1) {
      out.push({ role: "user", content: userRun[0].text ?? "" });
    } else {
      out.push({ role: "user", content: parts });
    }
    userRun = [];
  };
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const reasoning = pending.reasoning !== null && pending.reasoning.length > 0 ? pending.reasoning : void 0;
    const reasoningField = reasoning !== void 0 ? { reasoning_content: reasoning } : pending.reasoningPresent ? { reasoning_content: "" } : {};
    if (pending.toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: pending.text ?? null,
        tool_calls: pending.toolCalls,
        ...reasoningField
      });
    } else if (pending.text !== null) {
      out.push({ role: "assistant", content: pending.text, ...reasoningField });
    } else if (reasoning) {
      out.push({
        role: "assistant",
        content: null,
        reasoning_content: reasoning
      });
    }
    pending = null;
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      flushUserRun();
      if (!pending)
        pending = {
          text: null,
          toolCalls: [],
          reasoning: null,
          reasoningPresent: false
        };
      if (m.reasoningPresent) pending.reasoningPresent = true;
      if (m.contentType === "reasoning") {
        pending.reasoning = (pending.reasoning ?? "") + (m.reasoningContent ?? m.text ?? "");
      } else if (m.contentType === "text") {
        pending.text = (pending.text ?? "") + (m.text ?? "");
      } else if (m.contentType === "tool-call") {
        pending.toolCalls.push({
          id: m.toolCallId ?? `call_${m.id}`,
          type: "function",
          function: { name: m.toolName ?? "unknown", arguments: m.text ?? "" }
        });
      }
    } else {
      if (m.role !== "user") {
        flush();
        flushUserRun();
      }
      if (m.role === "system") {
        const raw = m.rawOpenaiMessage;
        if (raw) {
          const text = m.text ?? "";
          if (text !== stringContent(raw.content) && isPlainStringOrTextParts(raw.content)) {
            out.push({
              role: m.originalRole === "developer" ? "developer" : "system",
              content: typeof raw.content === "string" ? text : [{ type: "text", text }]
            });
          } else {
            out.push(raw);
          }
        } else {
          out.push({
            role: m.originalRole === "developer" ? "developer" : "system",
            content: m.text ?? ""
          });
        }
      } else if (m.role === "user" && isSummaryMessageId(m.id) && m.contentType === "text") {
        flush();
        flushUserRun();
        out.push({ role: "user", content: m.text ?? "" });
      } else if (m.role === "user") {
        flush();
        const prev = userRun[userRun.length - 1];
        if (prev && prev.wireIndex !== void 0 && m.wireIndex !== void 0 && prev.wireIndex !== m.wireIndex) {
          flushUserRun();
        }
        userRun.push(m);
      } else if (m.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: m.toolCallId ?? "",
          content: m.text ?? ""
        });
      }
    }
  }
  flush();
  flushUserRun();
  return out;
}
function injectOpenaiSystem(messages, parts) {
  if (parts.length === 0) return messages;
  const extra = parts.join("\n\n");
  if (messages.length > 0 && (messages[0]?.role === "system" || messages[0]?.role === "developer")) {
    const head = messages[0];
    const base = stringContent(head.content);
    const merged = base ? `${base}

---

${extra}` : extra;
    return [{ ...head, content: merged }, ...messages.slice(1)];
  }
  return [{ role: "system", content: extra }, ...messages];
}
function isPlainStringOrTextParts(content) {
  if (content == null || typeof content === "string") return true;
  return Array.isArray(content) && content.length > 0 && content.every(
    (p) => typeof p === "object" && p !== null && p.type === "text"
  );
}
function stringContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(
      (p) => typeof p === "string" ? p : p.type === "text" ? p.text ?? "" : ""
    ).join("\n");
  }
  return "";
}

// kernel/src/wire/formats.ts
function detectWireFormat(payload) {
  if (payload === null || typeof payload !== "object") return void 0;
  const p = payload;
  if (Array.isArray(p.contents)) return "google";
  if (Array.isArray(p.input)) return "responses";
  const messages = p.messages;
  if (!Array.isArray(messages)) return void 0;
  if ("system" in p || "anthropic_version" in p) return "anthropic";
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === "object" && typeof b.type === "string") {
          if (b.type === "tool_use" || b.type === "tool_result" || b.type === "thinking")
            return "anthropic";
          if (b.type === "text" && "cache_control" in b) return "anthropic";
        }
      }
    }
    if (Array.isArray(m.tool_calls)) return "openai";
    if (m.role === "tool" && typeof m.tool_call_id === "string")
      return "openai";
    if (m.role === "system" || m.role === "developer") return "openai";
  }
  return "openai";
}
export {
  anthropicToCore,
  coreToGoogle,
  coreToOpenai,
  detectWireFormat,
  extractSystem,
  injectGoogleSystem,
  injectOpenaiSystem,
  normalizeGoogleUserPartOrder
};
