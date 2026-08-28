// gemini batch api streaming adapter for pi.
//
// the batch api is non-streaming: you submit one or more generateContent
// requests as a job and poll until it completes (gemini batch jobs typically
// finish within minutes; the sla is 24h). this adapter wraps that flow in
// pi's AssistantMessageEventStream contract, emitting the full response as
// events once the job succeeds.
//
// jobs are submitted via @google/genai client.batches.create with a single
// inlined request, so results come back inlined in job.dest.inlinedResponses.
// aborting the stream cancels the underlying job.
import {
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  isThinkingPart,
  mapStopReason,
} from "@earendil-works/pi-ai/api/google-shared";
import { buildParams, thinkingConfigFor } from "./params.js";

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h batch sla

let toolCallCounter = 0;

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Request aborted"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    }
  });
}

/**
 * create the streamSimple implementation for the batch provider.
 * @param {object} deps injectable for testing
 * @param {() => object} deps.makeClient returns a @google/genai client
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {{pollIntervalMs?: number, timeoutMs?: number}} [deps.config]
 */
export function createBatchStream(deps) {
  const { makeClient } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.config?.pollIntervalMs
    ?? Number(process.env.GEMINI_BATCH_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = deps.config?.timeoutMs
    ?? Number(process.env.GEMINI_BATCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  return function streamSimple(model, context, options = {}) {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const output = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };

      let jobName = null;
      try {
        const apiKey = options.apiKey;
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        if (options.signal?.aborted) throw new Error("Request aborted");

        const client = makeClient(apiKey, model, options);
        const params = buildParams(model, context, {
          ...options,
          thinking: options.thinking ?? thinkingConfigFor(model, options.reasoning, options.thinkingBudgets),
        });

        // submit a single-request batch job
        const job = await client.batches.create({
          model: model.id,
          src: [{ contents: params.contents, config: params.config }],
        });
        jobName = job.name;
        if (!jobName) throw new Error("Batch job created without a resource name");

        // poll until terminal state
        const deadline = Date.now() + timeoutMs;
        let current = job;
        while (
          current.state !== "JOB_STATE_SUCCEEDED" &&
          current.state !== "JOB_STATE_FAILED" &&
          current.state !== "JOB_STATE_CANCELLED" &&
          current.state !== "JOB_STATE_EXPIRED"
        ) {
          if (options.signal?.aborted) throw new Error("Request aborted");
          if (Date.now() > deadline) {
            throw new Error(`Gemini batch job ${jobName} timed out after ${timeoutMs}ms`);
          }
          await sleep(pollIntervalMs, options.signal);
          current = await client.batches.get({ name: jobName });
        }

        if (current.state !== "JOB_STATE_SUCCEEDED") {
          throw new Error(
            `Gemini batch job ${jobName} ended in ${current.state}` +
            (current.error?.message ? `: ${current.error.message}` : ""),
          );
        }

        const inlined = current.dest?.inlinedResponses;
        if (!inlined?.length) {
          throw new Error(`Gemini batch job ${jobName} returned no inlined responses`);
        }
        const response = inlined[0].response;
        if (!response) {
          throw new Error(`Gemini batch job ${jobName} returned an empty response`);
        }
        const respError = response.error ?? inlined[0].error;
        if (respError?.message) {
          throw new Error(`Gemini batch request failed: ${respError.message}`);
        }

        stream.push({ type: "start", partial: output });

        const candidate = response.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text !== undefined) {
            if (isThinkingPart(part)) {
              output.content.push({
                type: "thinking",
                thinking: part.text,
                thinkingSignature: part.thoughtSignature,
              });
              const idx = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
              stream.push({ type: "thinking_delta", contentIndex: idx, delta: part.text, partial: output });
              stream.push({ type: "thinking_end", contentIndex: idx, content: part.text, partial: output });
            } else {
              output.content.push({ type: "text", text: part.text });
              const idx = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex: idx, partial: output });
              stream.push({ type: "text_delta", contentIndex: idx, delta: part.text, partial: output });
              stream.push({ type: "text_end", contentIndex: idx, content: part.text, partial: output });
            }
          }
          if (part.functionCall) {
            const providedId = part.functionCall.id;
            const needsNewId =
              !providedId ||
              output.content.some((b) => b.type === "toolCall" && b.id === providedId);
            const toolCallId = needsNewId
              ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
              : providedId;
            const toolCall = {
              type: "toolCall",
              id: toolCallId,
              name: part.functionCall.name || "",
              arguments: part.functionCall.args ?? {},
              ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
            };
            output.content.push(toolCall);
            const idx = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
            stream.push({
              type: "toolcall_delta",
              contentIndex: idx,
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            });
            stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
          }
        }

        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason;
          output.stopReason = mapStopReason(candidate.finishReason);
          if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
            output.stopReason = "toolUse";
          }
        }

        const um = response.usageMetadata;
        if (um) {
          output.usage = {
            input: (um.promptTokenCount || 0) - (um.cachedContentTokenCount || 0),
            output: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
            cacheRead: um.cachedContentTokenCount || 0,
            cacheWrite: 0,
            reasoning: um.thoughtsTokenCount || 0,
            totalTokens: um.totalTokenCount || 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          calculateCost(model, output.usage);
        }

        if (output.stopReason === "pending") {
          throw new Error("Gemini batch response had no finish reason");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error(
            output.rawStopReason
              ? `Provider stopped with: ${output.rawStopReason}`
              : "An unknown error occurred",
          );
        }

        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        // best effort: cancel any in-flight job on failure/abort
        if (jobName) {
          try {
            await deps.makeClient(options.apiKey, model, options).batches.cancel({ name: jobName });
          } catch {}
        }
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}
