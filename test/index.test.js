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
  for (const m of config.models) {
    assert.ok(m.cost.input > 0 && m.cost.output > 0);
    assert.ok(m.contextWindow > 0 && m.maxTokens > 0);
    assert.ok(m.reasoning);
    // batch pricing is 50% of interactive
    assert.ok(m.cost.output < 10, "batch pricing should be half of interactive");
  }
});
