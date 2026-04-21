// @spec specs/hermod-client.spec.md v1.2 §3.4

import { describe, it, expect } from "vitest";
import type { CanonicalModelName } from "@tanfeuille/bragi";
import {
  HermodError,
  HermodConfigError,
  HermodTimeoutError,
  HermodRetryExhaustedError,
  HermodAbortedError,
  HermodUpstreamError,
} from "../src/errors.js";

const SONNET = "claude-sonnet" as CanonicalModelName;

describe("HermodConfigError", () => {
  it("code littéral + instanceof chain", () => {
    const e = new HermodConfigError("config bad", { cause: "x" }, "claude-x");
    expect(e.code).toBe("HERMOD_CONFIG_ERROR");
    expect(e.canonicalName).toBe("claude-x");
    expect(e instanceof HermodConfigError).toBe(true);
    expect(e instanceof HermodError).toBe(true);
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe("HermodConfigError");
  });

  it("cause et canonicalName optionnels", () => {
    const e = new HermodConfigError("bare");
    expect(e.cause).toBeUndefined();
    expect(e.canonicalName).toBeUndefined();
  });
});

describe("HermodTimeoutError", () => {
  it("champs + message FR", () => {
    const e = new HermodTimeoutError(SONNET, "claude-sonnet-4-6", 120_000, 121_234, 2);
    expect(e.code).toBe("HERMOD_TIMEOUT");
    expect(e.canonicalName).toBe(SONNET);
    expect(e.canonicalId).toBe("claude-sonnet-4-6");
    expect(e.timeoutMs).toBe(120_000);
    expect(e.elapsedMs).toBe(121_234);
    expect(e.attempt).toBe(2);
    expect(e.message).toContain("Timeout 120000ms");
    expect(e.message).toContain("121234ms écoulés");
    expect(e.message).toContain("tentative 2");
  });
});

describe("HermodUpstreamError", () => {
  it("champs + message + cause optional", () => {
    const e = new HermodUpstreamError(SONNET, 401, "authentication_error", "Invalid API key");
    expect(e.code).toBe("HERMOD_UPSTREAM");
    expect(e.httpStatus).toBe(401);
    expect(e.upstreamCode).toBe("authentication_error");
    expect(e.upstreamMessage).toBe("Invalid API key");
    expect(e.cause).toBeUndefined();
    expect(e.message).toContain("401");
    expect(e.message).toContain("authentication_error");
  });
});

describe("HermodAbortedError", () => {
  it("champs + message avec/sans reason", () => {
    const e1 = new HermodAbortedError(SONNET);
    expect(e1.code).toBe("HERMOD_ABORTED");
    expect(e1.reason).toBeUndefined();
    expect(e1.message).toContain("Abort externe");

    const e2 = new HermodAbortedError(SONNET, "user cancelled");
    expect(e2.reason).toBe("user cancelled");
    expect(e2.message).toContain("user cancelled");
  });
});

describe("HermodRetryExhaustedError", () => {
  it("attempts + lastError + attemptsHistory", () => {
    const timeout = new HermodTimeoutError(SONNET, "claude-sonnet-4-6", 60_000, 60_500, 3);
    const history = [
      { attempt: 1, elapsed_ms: 60_100, error_code: "APITimeoutError", error_message: "t1", http_status: undefined },
      { attempt: 2, elapsed_ms: 60_200, error_code: "APITimeoutError", error_message: "t2", http_status: undefined },
      { attempt: 3, elapsed_ms: 60_500, error_code: "APITimeoutError", error_message: "t3", http_status: undefined },
    ];
    const e = new HermodRetryExhaustedError(SONNET, 3, timeout, 180_000, history);
    expect(e.code).toBe("HERMOD_RETRY_EXHAUSTED");
    expect(e.attempts).toBe(3);
    expect(e.lastError).toBe(timeout);
    expect(e.totalElapsedMs).toBe(180_000);
    expect(e.attemptsHistory).toHaveLength(3);
    expect(e.message).toContain("3 tentatives");
    expect(e.message).toContain("HERMOD_TIMEOUT");
  });

  it("lastError network wrap", () => {
    const netLast = {
      code: "HERMOD_NETWORK_ERROR" as const,
      errno: "ECONNRESET" as const,
      cause: new Error("conn reset"),
    };
    const e = new HermodRetryExhaustedError(SONNET, 3, netLast, 5_000, []);
    expect(e.lastError.code).toBe("HERMOD_NETWORK_ERROR");
    expect(e.message).toContain("network ECONNRESET");
  });

  it("lastError upstream 5xx", () => {
    const upstream = new HermodUpstreamError(SONNET, 503, "overloaded_error", "overloaded");
    const e = new HermodRetryExhaustedError(SONNET, 2, upstream, 3_000, []);
    expect(e.message).toContain("HTTP 503");
  });
});

describe("Redaction API key (R10)", () => {
  it("redacte sk-ant-* dans les messages", () => {
    const e = new HermodConfigError("Error with sk-ant-api03-test-REAL-key here");
    expect(e.message).not.toContain("sk-ant-api03-test-REAL-key");
    expect(e.message).toContain("sk-***");
  });

  it("redacte Bearer token", () => {
    const e = new HermodConfigError("got Bearer eyJhbGciOi.foo.bar here");
    expect(e.message).not.toContain("eyJhbGciOi");
    expect(e.message).toContain("Bearer ***");
  });

  it("redacte AWS AKIA keys", () => {
    const e = new HermodConfigError("leaked AKIAZZZZZZZZZZZZZZZZ oops");
    expect(e.message).not.toContain("AKIAZZZZZZZZZZZZZZZZ");
    expect(e.message).toContain("AKIA***");
  });

  it("redacte GitHub PAT ghp_", () => {
    const e = new HermodConfigError("token ghp_abcdef1234567890abcdef1234567890abcdef");
    expect(e.message).not.toContain("ghp_abcdef1234567890");
    expect(e.message).toContain("ghp_***");
  });
});

describe("Hiérarchie — narrowing cross-realm via code (R2a, EC49)", () => {
  it("tous les codes commencent par HERMOD_", () => {
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
      expect(e.code).toMatch(/^HERMOD_/);
    }
  });
});
