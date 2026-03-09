import { GoogleGenAI } from "@google/genai";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export class GeminiProvider implements LlmProvider {
  private client: GoogleGenAI;
  private model: string;

  constructor(model?: string) {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    this.model = model ?? "gemini-2.5-flash";
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: req.user,
      config: {
        systemInstruction: req.system,
        maxOutputTokens: req.maxTokens,
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error("Empty response from Gemini");
    }

    return { text, model: this.model };
  }
}
