import { spawn } from "node:child_process";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export class ClaudeCliProvider implements LlmProvider {
  private model: string | undefined;

  constructor(model?: string) {
    this.model = model;
  }

  generate(req: LlmRequest): Promise<LlmResponse> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p", req.user,
        "--system-prompt", req.system,
        "--output-format", "stream-json",
        "--verbose",
      ];

      if (this.model) {
        args.push("--model", this.model);
      }

      const env = { ...process.env };
      delete env.CLAUDECODE;

      const child = spawn("claude", args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let fullText = "";
      let usedModel = this.model ?? "claude-cli";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);

            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text.length > fullText.length) {
                  const delta = block.text.slice(fullText.length);
                  process.stdout.write(delta);
                  fullText = block.text;
                }
              }
              if (event.message.model) {
                usedModel = event.message.model;
              }
            } else if (event.type === "result" && event.result) {
              const result = event.result as string;
              if (result.length > fullText.length) {
                process.stdout.write(result.slice(fullText.length));
              }
              fullText = result;
            }
          } catch {
            // not valid JSON, ignore
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        console.error(`[LLM:stderr] ${text.trim()}`);
      });

      child.on("close", (code) => {
        if (fullText) process.stdout.write("\n");

        if (code !== 0) {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        const text = fullText.trim();
        if (!text) {
          reject(new Error("Empty response from Claude CLI"));
          return;
        }

        resolve({ text, model: usedModel });
      });

      child.on("error", (err) => {
        reject(new Error(`Claude CLI failed to start: ${err.message}`));
      });
    });
  }
}
