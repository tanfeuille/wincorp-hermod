// @spec specs/hermod-client.spec.md v1.2 §3.2 + §4.1 R2a

import { describe, it, expect } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import type { CanonicalModelName } from "@tanfeuille/bragi";
import { isHermodError, isAnthropicSdkError } from "../src/api.js";
import {
  HermodError,
  HermodConfigError,
  HermodTimeoutError,
  HermodUpstreamError,
  HermodAbortedError,
  HermodRetryExhaustedError,
} from "../src/errors.js";

const SONNET = "claude-sonnet" as CanonicalModelName;

describe("isHermodError (R2a whitelist)", () => {
  it("true pour toutes les erreurs hermod connues", () => {
    const errors = [
      new HermodConfigError("x"),
      new HermodTimeoutError(SONNET, "x", 1, 1, 1),
      new HermodUpstreamError(SONNET, 500, "c", "m"),
      new HermodAbortedError(SONNET),
      new HermodRetryExhaustedError(
        SONNET,
        2,
        new HermodTimeoutError(SONNET, "x", 1, 1, 1),
        1,
        [],
      ),
    ];
    for (const e of errors) {
      expect(isHermodError(e)).toBe(true);
    }
  });

  it("false pour erreurs non-hermod standard", () => {
    expect(isHermodError(new Error("x"))).toBe(false);
    expect(isHermodError(new TypeError("x"))).toBe(false);
    expect(isHermodError(null)).toBe(false);
    expect(isHermodError(undefined)).toBe(false);
    expect(isHermodError("string error")).toBe(false);
    expect(isHermodError(42)).toBe(false);
  });

  it("EC56 : refuse pollution {code: 'HERMOD_FAKE'}", () => {
    expect(isHermodError({ code: "HERMOD_FAKE" })).toBe(false);
    expect(isHermodError({ code: "HERMOD_INJECTION" })).toBe(false);
    expect(isHermodError({ code: "hermod_config_error" })).toBe(false); // lowercase
    expect(isHermodError({ code: " HERMOD_CONFIG_ERROR " })).toBe(false); // whitespace
  });

  it("accepte objet cross-realm avec code littéral whitelisted", () => {
    const fake = { code: "HERMOD_CONFIG_ERROR", message: "from other realm" };
    expect(isHermodError(fake)).toBe(true);
  });

  it("accepte tous les codes whitelisted exactement", () => {
    for (const code of [
      "HERMOD_CONFIG_ERROR",
      "HERMOD_TIMEOUT",
      "HERMOD_RETRY_EXHAUSTED",
      "HERMOD_ABORTED",
      "HERMOD_UPSTREAM",
    ]) {
      expect(isHermodError({ code })).toBe(true);
    }
  });

  it("type guard narrowing fonctionne", () => {
    const e: unknown = new HermodConfigError("x");
    if (isHermodError(e)) {
      // TS doit narrow vers HermodError
      expect(typeof e.code).toBe("string");
      expect(e.code).toBe("HERMOD_CONFIG_ERROR");
    } else {
      expect.fail("expected narrowing");
    }
  });
});

describe("isAnthropicSdkError", () => {
  it("true pour APIError instance", () => {
    const e = new APIError(500, { type: "internal" }, "msg", new Headers());
    expect(isAnthropicSdkError(e)).toBe(true);
  });

  it("true pour objet structurellement conforme", () => {
    const fake = { status: 500, error: { type: "internal_error", message: "x" } };
    expect(isAnthropicSdkError(fake)).toBe(true);
  });

  it("false pour erreurs non-SDK", () => {
    expect(isAnthropicSdkError(new Error("plain"))).toBe(false);
    expect(isAnthropicSdkError({})).toBe(false);
    expect(isAnthropicSdkError({ status: 500 })).toBe(false); // manque error.type
    expect(isAnthropicSdkError({ status: 500, error: {} })).toBe(false);
    expect(isAnthropicSdkError(null)).toBe(false);
    expect(isAnthropicSdkError("string")).toBe(false);
  });

  it("false pour HermodError", () => {
    expect(isAnthropicSdkError(new HermodConfigError("x"))).toBe(false);
  });
});
