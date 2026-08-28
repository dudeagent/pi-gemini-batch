import test from "node:test";
import assert from "node:assert/strict";
import registerExtension from "../src/index.js";

test("extension registers google-batch provider with models and streamSimple", () => {
  const registered = [];
  const pi = {
    registerProvider: (name, config) => registered.push({ name, config }),
  };
  registerExtension(pi);

  assert.equal(registered.length, 1);
  const { name, config } = registered[0];
  assert.equal(name, "google-batch");
  assert.equal(config.apiKey, "$GEMINI_API_KEY");
  assert.equal(config.api, "google-generative-ai");
  assert.equal(typeof config.streamSimple, "function");

  const ids = config.models.map((m) => m.id);
  assert.ok(ids.includes("gemini-2.5-flash"));
  assert.ok(ids.includes("gemini-2.5-pro"));
  // new-generation models from the docs (2026-08-28)
  for (const id of [
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
  ]) {
    assert.ok(ids.includes(id), `missing model ${id}`);
  }
  assert.ok(!ids.includes("gemini-3-flash"), "old gemini-3-flash id should be gone");

  // spot-check batch prices (half of interactive) for new models
  const byId = Object.fromEntries(config.models.map((m) => [m.id, m]));
  assert.equal(byId["gemini-3.7-flash"].cost.input, 0.375);
  assert.equal(byId["gemini-3.7-flash"].cost.output, 1.875);
  assert.equal(byId["gemini-3.1-pro-preview"].cost.input, 1);
  assert.equal(byId["gemini-3.1-pro-preview"].cost.output, 6);
  assert.equal(byId["gemini-3-flash-preview"].cost.input, 0.25);
  assert.equal(byId["gemini-3-flash-preview"].cost.output, 1.5);

  for (const m of config.models) {
    assert.ok(m.cost.input > 0 && m.cost.output > 0);
    assert.ok(m.contextWindow > 0 && m.maxTokens > 0);
    assert.ok(m.reasoning);
    // batch pricing is 50% of interactive
    assert.ok(m.cost.output < 10, "batch pricing should be half of interactive");
  }
});
