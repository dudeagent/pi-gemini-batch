import test from "node:test";
import assert from "node:assert/strict";
import { createBatchStream } from "../src/batch.js";

const model = {
  id: "gemini-2.5-flash",
  name: "Gemini 2.5 Flash (Batch)",
  api: "google-generative-ai",
  provider: "google-batch",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.15, output: 1.25, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
};

function makeContext(overrides = {}) {
  return {
    systemPrompt: "you are a test",
    messages: [
      { role: "user", content: "hello" },
    ],
    tools: [],
    ...overrides,
  };
}

// fake @google/genai client
function fakeClient({ states, response, createError, getError }) {
  const calls = { create: 0, get: 0, cancel: 0, cancelName: null };
  let stateIdx = 0;
  const job = (state) => ({
    name: "batches/abc123",
    state,
    ...(state === "JOB_STATE_SUCCEEDED"
      ? {
          dest: {
            inlinedResponses: [
              { response: { candidates: response.candidates, usageMetadata: response.usageMetadata } },
            ],
          },
        }
      : {}),
  });
  return {
    calls,
    batches: {
      async create(params) {
        calls.create++;
        calls.createParams = params;
        if (createError) throw createError;
        return job(states[0]);
      },
      async get() {
        calls.get++;
        if (getError) throw getError;
        const state = states[Math.min(stateIdx, states.length - 1)];
        stateIdx++;
        return job(state);
      },
      async cancel({ name }) {
        calls.cancel++;
        calls.cancelName = name;
      },
    },
  };
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const events = [];
    stream.subscribe?.(); // not used; AssistantMessageEventStream is async iterable? use push handler below
    resolve(events);
  });
}

// pi's createAssistantMessageEventStream is an async iterable of events
async function drain(stream) {
  const events = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

test("successful batch job emits text, usage, done", async () => {
  const client = fakeClient({
    states: ["JOB_STATE_QUEUED", "JOB_STATE_RUNNING", "JOB_STATE_SUCCEEDED"],
    response: {
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hi there" }] } }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 50, totalTokenCount: 130 },
    },
  });
  const streamSimple = createBatchStream({
    makeClient: () => client,
    sleep: async () => {},
    config: { pollIntervalMs: 1, timeoutMs: 1000 },
  });

  const events = await drain(streamSimple(model, makeContext(), { apiKey: "k" }));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["start", "text_start", "text_delta", "text_end", "done"]);

  const done = events.at(-1);
  assert.equal(done.reason, "stop");
  assert.equal(done.message.content[0].text, "hi there");
  // input excludes cached tokens
  assert.equal(done.message.usage.input, 80);
  assert.equal(done.message.usage.output, 50);
  assert.equal(done.message.usage.totalTokens, 130);
  assert.ok(done.message.usage.cost.total > 0);

  // submitted a single inlined request with converted contents + system instruction
  assert.equal(client.calls.create, 1);
  const src = client.calls.createParams.src;
  assert.equal(src.length, 1);
  assert.equal(src[0].config.systemInstruction, "you are a test");
  assert.equal(src[0].model, undefined); // model passed at top level
  assert.equal(client.calls.createParams.model, "gemini-2.5-flash");
  assert.equal(client.calls.get, 3); // queued, running, then success
  assert.equal(client.calls.cancel, 0);
});

test("tool call in batch response becomes toolCall block with stopReason toolUse", async () => {
  const client = fakeClient({
    states: ["JOB_STATE_SUCCEEDED"],
    response: {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
  });
  const streamSimple = createBatchStream({
    makeClient: () => client,
    sleep: async () => {},
    config: { pollIntervalMs: 1, timeoutMs: 1000 },
  });

  const events = await drain(streamSimple(model, makeContext(), { apiKey: "k" }));
  const done = events.at(-1);
  assert.equal(done.reason, "toolUse");
  const call = done.message.content[0];
  assert.equal(call.type, "toolCall");
  assert.equal(call.name, "bash");
  assert.deepEqual(call.arguments, { command: "ls" });
  assert.ok(call.id.length > 0);
});

test("thinking parts map to thinking blocks", async () => {
  const client = fakeClient({
    states: ["JOB_STATE_SUCCEEDED"],
    response: {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: "pondering", thought: true }, { text: "answer" }] },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
  });
  const streamSimple = createBatchStream({
    makeClient: () => client,
    sleep: async () => {},
    config: { pollIntervalMs: 1, timeoutMs: 1000 },
  });

  const events = await drain(streamSimple(model, makeContext(), { apiKey: "k" }));
  const done = events.at(-1);
  assert.equal(done.message.content[0].type, "thinking");
  assert.equal(done.message.content[0].thinking, "pondering");
  assert.equal(done.message.content[1].text, "answer");
});

test("failed job produces error event", async () => {
  const client = fakeClient({
    states: ["JOB_STATE_FAILED"],
    response: { candidates: [], usageMetadata: {} },
  });
  const streamSimple = createBatchStream({
    makeClient: () => client,
    sleep: async () => {},
    config: { pollIntervalMs: 1, timeoutMs: 1000 },
  });

  const events = await drain(streamSimple(model, makeContext(), { apiKey: "k" }));
  const err = events.at(-1);
  assert.equal(err.type, "error");
  assert.equal(err.error.stopReason, "error");
  assert.match(err.error.errorMessage, /JOB_STATE_FAILED/);
});

test("timeout cancels the job and errors", async () => {
  const client = fakeClient({
    states: ["JOB_STATE_RUNNING"],
    response: { candidates: [], usageMetadata: {} },
  });
  const streamSimple = createBatchStream({
    makeClient: () => client,
    sleep: async () => {},
    config: { pollIntervalMs: 1, timeoutMs: 5 },
  });

  const events = await drain(streamSimple(model, makeContext(), { apiKey: "k" }));
  const err = events.at(-1);
  assert.equal(err.type, "error");
  assert.match(err.error.errorMessage, /timed out/);
  assert.equal(client.calls.cancel, 1);
  assert.equal(client.calls.cancelName, "batches/abc123");
});

test("abort cancels the job and emits aborted", async () => {
  const client = fakeClient({
    states: ["JOB_STATE_RUNNING", "JOB_STATE_RUNNING", "JOB_STATE_RUNNING"],
    response: { candidates: [], usageMetadata: {} },
  });
  const controller = new AbortController();
  const streamSimple = createBatchStream({
    makeClient: () => client,
    // first sleep resolves to let create happen, subsequent rejects on abort
    sleep: async (ms, signal) => {
      if (!signal) return;
      if (client.calls.get === 0) return;
      controller.abort();
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request aborted")), 1),
      );
    },
    config: { pollIntervalMs: 1, timeoutMs: 10_000 },
  });

  const events = await drain(streamSimple(model, makeContext(), { apiKey: "k", signal: controller.signal }));
  const err = events.at(-1);
  assert.equal(err.type, "error");
  assert.equal(err.error.stopReason, "aborted");
  assert.equal(client.calls.cancel, 1);
});

test("missing api key errors immediately", async () => {
  const client = fakeClient({ states: [], response: {} });
  const streamSimple = createBatchStream({
    makeClient: () => client,
    sleep: async () => {},
    config: { pollIntervalMs: 1, timeoutMs: 1000 },
  });
  const events = await drain(streamSimple(model, makeContext(), {}));
  const err = events.at(-1);
  assert.equal(err.type, "error");
  assert.match(err.error.errorMessage, /No API key/);
  assert.equal(client.calls.create, 0);
});

test("create failure produces error event without polling", async () => {
  const client = fakeClient({
    states: [],
    response: {},
    createError: new Error("quota exceeded"),
  });
  const streamSimple = createBatchStream({
    makeClient: () => client,
    sleep: async () => {},
    config: { pollIntervalMs: 1, timeoutMs: 1000 },
  });
  const events = await drain(streamSimple(model, makeContext(), { apiKey: "k" }));
  const err = events.at(-1);
  assert.equal(err.type, "error");
  assert.match(err.error.errorMessage, /quota exceeded/);
  assert.equal(client.calls.get, 0);
});
