// pi extension: registers a "google-batch" provider that runs agent sessions
// through the gemini batch api at ~50% of interactive pricing.
//
// tradeoff: batch jobs are non-streaming and can take minutes to complete
// (google's sla is 24h), so this is meant for autonomous/agent runs where
// cost matters more than latency. models are the same gemini models with
// batch pricing (half the interactive price).
//
// config via env:
//   GEMINI_API_KEY                 - api key (required)
//   GEMINI_BATCH_POLL_INTERVAL_MS  - poll interval (default 10s)
//   GEMINI_BATCH_TIMEOUT_MS        - give up on a job after this long (default 24h)
import { GoogleGenAI } from "@google/genai";
import { createBatchStream } from "./batch.js";

// interactive prices: flash 0.30/2.50, flash-lite 0.10/0.40, pro 1.25/10.00.
// gemini batch api bills at 50% of interactive for the same model.
function batchModel(id, name, input, output, opts = {}) {
  return {
    id,
    name,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: input / 2,
      output: output / 2,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: opts.contextWindow ?? 1_048_576,
    maxTokens: opts.maxTokens ?? 65_536,
  };
}

const MODELS = [
  batchModel("gemini-2.5-flash", "Gemini 2.5 Flash (Batch)", 0.3, 2.5),
  batchModel("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite (Batch)", 0.1, 0.4, { maxTokens: 64_000 }),
  batchModel("gemini-2.5-pro", "Gemini 2.5 Pro (Batch)", 1.25, 10, { maxTokens: 65_536 }),
  batchModel("gemini-3-flash", "Gemini 3 Flash (Batch)", 0.3, 2.5),
  batchModel("gemini-3-pro", "Gemini 3 Pro (Batch)", 1.25, 10, { maxTokens: 65_536 }),
];

export default function (pi) {
  pi.registerProvider("google-batch", {
    name: "Google Gemini Batch API",
    baseUrl: "https://generativelanguage.googleapis.com/v1alpha",
    apiKey: "$GEMINI_API_KEY",
    api: "google-generative-ai",
    models: MODELS,
    streamSimple: createBatchStream({
      makeClient: (apiKey, model) =>
        new GoogleGenAI({
          apiKey,
          httpOptions: model.baseUrl ? { baseUrl: model.baseUrl, apiVersion: "" } : undefined,
        }),
    }),
  });
}
