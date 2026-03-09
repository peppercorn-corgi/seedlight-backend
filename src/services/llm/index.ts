import { config } from "../../config/index.js";
import type { LlmProvider } from "./types.js";
import { ClaudeApiProvider } from "./claude-api.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { GeminiProvider } from "./gemini.js";

export type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

let instance: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (instance) return instance;

  const model = config.LLM_MODEL || undefined;

  switch (config.LLM_PROVIDER) {
    case "claude-cli":
      instance = new ClaudeCliProvider(model);
      break;
    case "gemini":
      instance = new GeminiProvider(model);
      break;
    case "claude-api":
    default:
      instance = new ClaudeApiProvider(model);
      break;
  }

  console.log(`[LLM] Using provider: ${config.LLM_PROVIDER}, model: ${model ?? "default"}`);
  return instance;
}
