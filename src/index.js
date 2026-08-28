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

// interactive prices (per 1M tokens, docs 2026-08-28): batch bills at 50%.
//   2.5 flash 0.30/2.50 | 2.5 flash-lite 0.10/0.40 | 2.5 pro 1.25/10.00
//   3 flash-preview 0.50/3.00 | 3.1 pro-preview 2.00/12.00 | 3.1 flash-lite 0.25/1.50
//   3.5 flash 1.50/9.00 | 3.5 flash-lite 0.30/2.50
//   3.6 flash 0.75/3.75 | 3.7 flash 0.75/3.75 (promo pricing thru 2026-12-31, then 1.50/7.50)
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
  batchModel("gemini-3-flash-preview", "Gemini 3 Flash Preview (Batch)", 0.5, 3),
  batchModel("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite (Batch)", 0.25, 1.5, { maxTokens: 64_000 }),
  batchModel("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview (Batch)", 2, 12),
  batchModel("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite (Batch)", 0.3, 2.5, { maxTokens: 64_000 }),
  batchModel("gemini-3.5-flash", "Gemini 3.5 Flash (Batch)", 1.5, 9),
  batchModel("gemini-3.6-flash", "Gemini 3.6 Flash (Batch)", 0.75, 3.75),
  batchModel("gemini-3.7-flash", "Gemini 3.7 Flash (Batch)", 0.75, 3.75),
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
