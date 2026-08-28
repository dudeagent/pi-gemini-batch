// build generateContent params for a batch request, mirroring what the
// built-in pi google provider would send so batch and interactive runs behave
// the same. reuses pi-ai's shared google converters rather than duplicating
// message/tool logic.
import {
  convertMessages,
  convertTools,
  supportsGoogleStrictToolSampling,
  resolveGoogleFunctionCallingMode,
} from "@earendil-works/pi-ai/api/google-shared";
// not exported from pi-ai's public subpaths, inline the same implementation
function sanitizeSurrogates(text) {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// mirrors pi-ai's google-generative-ai thinking helpers
function isGemini3ProModel(model) {
  return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}
function isGemini3FlashModel(model) {
  const id = model.id.toLowerCase();
  return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}
function isGemma4Model(model) {
  return /gemma-?4/.test(model.id.toLowerCase());
}
function getDisabledThinkingConfig(model) {
  if (isGemini3ProModel(model)) return { thinkingLevel: "LOW" };
  if (isGemini3FlashModel(model) || isGemma4Model(model)) return { thinkingLevel: "MINIMAL" };
  return { thinkingBudget: 0 };
}
function getThinkingLevel(effort, model) {
  if (isGemini3ProModel(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return "LOW";
      default:
        return "HIGH";
    }
  }
  if (isGemma4Model(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return "MINIMAL";
      default:
        return "HIGH";
    }
  }
  switch (effort) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}
function getGoogleBudget(model, effort, customBudgets) {
  if (customBudgets?.[effort] !== undefined) return customBudgets[effort];
  if (model.id.includes("2.5-pro")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[effort] ?? -1;
  }
  if (model.id.includes("2.5-flash-lite")) {
    return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[effort] ?? -1;
  }
  if (model.id.includes("2.5-flash")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[effort] ?? -1;
  }
  return -1;
}

/**
 * @param {object} model pi model def
 * @param {object} context pi Context (messages, tools, systemPrompt)
 * @param {object} options pi stream options (temperature, maxTokens, thinking, toolChoice)
 */
export function buildParams(model, context, options = {}) {
  const contents = convertMessages(model, context);
  const generationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;

  const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
  const functionCallingMode = context.tools?.length
    ? resolveGoogleFunctionCallingMode(context.tools, options.toolChoice, supportsStrictMode)
    : undefined;

  const config = {
    ...(Object.keys(generationConfig).length > 0 && generationConfig),
    ...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
    ...(context.tools?.length > 0 && {
      tools: convertTools(context.tools, false, supportsStrictMode),
    }),
    ...(functionCallingMode !== undefined && {
      toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
    }),
  };

  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig = { includeThoughts: true };
    if (options.thinking.level !== undefined) {
      thinkingConfig.thinkingLevel = options.thinking.level;
    } else if (options.thinking.budgetTokens !== undefined) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
    config.thinkingConfig = thinkingConfig;
  } else if (model.reasoning && options.thinking && !options.thinking.enabled) {
    config.thinkingConfig = getDisabledThinkingConfig(model);
  }

  return { model: model.id, contents, config };
}

// map pi reasoning effort ("minimal".."high", or "off") to a thinking config,
// same rules as the built-in google provider's streamSimple
export function thinkingConfigFor(model, reasoning, thinkingBudgets) {
  if (!reasoning) return { enabled: false };
  let effort = reasoning;
  if (effort === "off") effort = "high";
  if (isGemini3ProModel(model) || isGemini3FlashModel(model) || isGemma4Model(model)) {
    return { enabled: true, level: getThinkingLevel(effort, model) };
  }
  return { enabled: true, budgetTokens: getGoogleBudget(model, effort, thinkingBudgets) };
}
