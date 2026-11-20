import { describe, expect, it } from "vitest";
import { chatRequest, jobParams, promptTokenEstimate } from "../src/core/chat.js";

const body = (content: string, extra: object = {}) =>
  chatRequest.parse({ model: "m", messages: [{ role: "user", content }], ...extra });

describe("prompt token estimate", () => {
  it("counts about a token per 4 ASCII characters and one per other code point", () => {
    expect(promptTokenEstimate(body(""))).toBe(0);
    expect(promptTokenEstimate(body("abcd"))).toBe(1);
    expect(promptTokenEstimate(body("abcde"))).toBe(2);
    expect(promptTokenEstimate(body("é".repeat(10)))).toBe(10);
    // An emoji is one code point (two UTF-16 units), so one token.
    expect(promptTokenEstimate(body("😀😀"))).toBe(2);
    expect(
      promptTokenEstimate(
        body("ab", {
          messages: [
            { role: "user", content: "ab" },
            { role: "system", content: "cd" },
          ],
        }),
      ),
    ).toBe(1);
  });
});

describe("chat request validation", () => {
  it("rejects empty stop strings", () => {
    expect(chatRequest.safeParse({ model: "m", messages: [{ role: "user", content: "x" }], stop: "" }).success).toBe(
      false,
    );
    expect(
      chatRequest.safeParse({ model: "m", messages: [{ role: "user", content: "x" }], stop: ["a", ""] }).success,
    ).toBe(false);
    expect(chatRequest.safeParse({ model: "m", messages: [{ role: "user", content: "x" }], stop: ["a"] }).success).toBe(
      true,
    );
  });

  it("forwards only whitelisted params, with max_tokens defaulted, and nulls as unset", () => {
    expect(jobParams(body("x"))).toEqual({ max_tokens: 4096 });
    expect(
      jobParams(body("x", { temperature: null, stop: "END", chat_template_kwargs: { enable_thinking: false } })),
    ).toEqual({
      max_tokens: 4096,
      stop: ["END"],
      enable_thinking: false,
    });
  });
});
