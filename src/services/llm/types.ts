export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
}

export interface LlmProvider {
  generate(req: LlmRequest): Promise<LlmResponse>;
}
