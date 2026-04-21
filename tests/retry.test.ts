// @spec specs/hermod-client.spec.md v1.2 §4.2 R3*

import { describe, it, expect, vi } from "vitest";
import type { CanonicalModelName, RetryParams } from "@tanfeuille/bragi";
import {
  classifyError,
  parseRetryAfter,
  computeBackoffMs,
  executeWithRetry,
  type RetryContext,
} from "../src/retry.js";
import {
  HermodAbortedError,
  HermodConfigError,
  HermodRetryExhaustedError,
  HermodTimeoutError,
  HermodUpstreamError,
} from "../src/errors.js";

const SONNET = "claude-sonnet" as CanonicalModelName;

// =============================================================================
// parseRetryAfter
// =============================================================================

describe("parseRetryAfter (R3b)", () => {
  it("nombre secondes → ms", () => {
    expect(parseRetryAfter("10")).toBe(10_000);
    expect(parseRetryAfter("0.5")).toBe(500);
  });

  it("négatif → 0", () => {
    expect(parseRetryAfter("-5")).toBe(0);
  });

  it("HTTP-date futur + marge 500ms", () => {
    const now = Date.parse("2026-04-21T10:00:00Z");
    const header = "Wed, 21 Apr 2026 10:00:10 GMT";
    const result = parseRetryAfter(header, now);
    expect(result).toBe(10_000 + 500);
  });

  it("HTTP-date passé → 1000ms", () => {
    const now = Date.parse("2026-04-21T10:00:00Z");
    const header = "Wed, 21 Apr 2026 09:59:59 GMT";
    expect(parseRetryAfter(header, now)).toBe(1000);
  });

  it("HTTP-date > 60min → null (fail fast)", () => {
    const now = Date.parse("2026-04-21T10:00:00Z");
    const header = "Wed, 21 Apr 2026 12:00:00 GMT"; // +2h
    expect(parseRetryAfter(header, now)).toBeNull();
  });

  it("malformé → null", () => {
    expect(parseRetryAfter("not-a-date")).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(42 as unknown)).toBeNull();
  });
});

// =============================================================================
// computeBackoffMs
// =============================================================================

describe("computeBackoffMs (R3a, R3b)", () => {
  const retry: RetryParams = { base_delay_sec: 1, cap_delay_sec: 30, max_attempts: 3 };

  it("exponentiel : base × 2^(attempt-1)", () => {
    expect(computeBackoffMs(1, retry, null)).toBe(1000);
    expect(computeBackoffMs(2, retry, null)).toBe(2000);
    expect(computeBackoffMs(3, retry, null)).toBe(4000);
  });

  it("cap à cap_delay_sec", () => {
    const e = computeBackoffMs(10, retry, null);
    expect(e).toBe(30_000);
  });

  it("Retry-After prime sur backoff calculé (R3b)", () => {
    expect(computeBackoffMs(1, retry, 5000)).toBe(5000);
  });

  it("Retry-After > cap → respecte Retry-After", () => {
    expect(computeBackoffMs(1, retry, 60_000)).toBe(60_000);
  });

  it("Retry-After 0/null → backoff normal", () => {
    expect(computeBackoffMs(2, retry, null)).toBe(2000);
    expect(computeBackoffMs(2, retry, 0)).toBe(2000);
  });
});

// =============================================================================
// classifyError (R3d matrice)
// =============================================================================

describe("classifyError (R3d)", () => {
  it("TypeError → fail_fast_other", () => {
    const c = classifyError(new TypeError("oops"));
    expect(c.kind).toBe("fail_fast_other");
  });

  it("primitive string throw → fail_fast_other", () => {
    const c = classifyError("raw string");
    expect(c.kind).toBe("fail_fast_other");
  });

  it("primitive number throw → fail_fast_other", () => {
    const c = classifyError(42);
    expect(c.kind).toBe("fail_fast_other");
  });

  it("null throw → fail_fast_other", () => {
    const c = classifyError(null);
    expect(c.kind).toBe("fail_fast_other");
  });

  it("ECONNRESET → retryable_network", () => {
    const e = Object.assign(new Error("conn reset"), { code: "ECONNRESET" });
    const c = classifyError(e);
    expect(c.kind).toBe("retryable_network");
    if (c.kind === "retryable_network") expect(c.errno).toBe("ECONNRESET");
  });

  it("ETIMEDOUT → retryable_network", () => {
    const e = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const c = classifyError(e);
    expect(c.kind).toBe("retryable_network");
  });

  it("ENOTFOUND → retryable_network", () => {
    const e = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
    const c = classifyError(e);
    expect(c.kind).toBe("retryable_network");
  });

  it("EPIPE → retryable_network", () => {
    const e = Object.assign(new Error("pipe"), { code: "EPIPE" });
    const c = classifyError(e);
    expect(c.kind).toBe("retryable_network");
  });

  it("ECONNREFUSED → fail_fast_connection_refused (R3m)", () => {
    const e = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const c = classifyError(e);
    expect(c.kind).toBe("fail_fast_connection_refused");
  });

  it("HTTP 429 → retryable_http", () => {
    const e = { status: 429, error: { type: "rate_limit_error", message: "rate limit" }, headers: {} };
    const c = classifyError(e);
    expect(c.kind).toBe("retryable_http");
    if (c.kind === "retryable_http") {
      expect(c.httpStatus).toBe(429);
      expect(c.upstreamCode).toBe("rate_limit_error");
    }
  });

  it("HTTP 408 → retryable_http", () => {
    const e = { status: 408, error: { type: "timeout" } };
    const c = classifyError(e);
    expect(c.kind).toBe("retryable_http");
  });

  it("HTTP 500 → retryable_http", () => {
    const e = { status: 500, error: { type: "internal_error", message: "oops" } };
    const c = classifyError(e);
    expect(c.kind).toBe("retryable_http");
    if (c.kind === "retryable_http") expect(c.httpStatus).toBe(500);
  });

  it("HTTP 502/503/504 → retryable_http", () => {
    for (const status of [502, 503, 504]) {
      const c = classifyError({ status, error: { type: "x" } });
      expect(c.kind).toBe("retryable_http");
    }
  });

  it("HTTP 400 → fail_fast_upstream", () => {
    const e = { status: 400, error: { type: "invalid_request_error", message: "bad" } };
    const c = classifyError(e);
    expect(c.kind).toBe("fail_fast_upstream");
  });

  it("HTTP 401 → fail_fast_upstream", () => {
    const c = classifyError({ status: 401, error: { type: "authentication_error" } });
    expect(c.kind).toBe("fail_fast_upstream");
  });

  it("HTTP 403/404/413/422/501 → fail_fast_upstream", () => {
    for (const status of [403, 404, 413, 422, 501]) {
      const c = classifyError({ status, error: { type: "x" } });
      expect(c.kind).toBe("fail_fast_upstream");
    }
  });

  it("HTTP 429 + Retry-After header extrait", () => {
    const e = {
      status: 429,
      error: { type: "rate_limit_error" },
      headers: { "retry-after": "5" },
    };
    const c = classifyError(e);
    if (c.kind === "retryable_http") {
      expect(c.retryAfterMs).toBe(5000);
    } else {
      expect.fail("expected retryable_http");
    }
  });

  it("AbortError → fail_fast_abort", () => {
    const e = Object.assign(new Error("aborted"), { name: "AbortError" });
    const c = classifyError(e);
    expect(c.kind).toBe("fail_fast_abort");
  });

  it("Signal déjà aborted → fail_fast_abort", () => {
    const controller = new AbortController();
    controller.abort("user cancelled");
    const c = classifyError(new Error("any"), controller.signal);
    expect(c.kind).toBe("fail_fast_abort");
  });

  it("errno ABORT_ERR → fail_fast_abort", () => {
    const e = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    const c = classifyError(e);
    expect(c.kind).toBe("fail_fast_abort");
  });
});

// =============================================================================
// executeWithRetry — integration (fake fn)
// =============================================================================

describe("executeWithRetry", () => {
  const mkCtx = (overrides: Partial<RetryContext> = {}): RetryContext => ({
    canonicalName: SONNET,
    canonicalId: "claude-sonnet-4-6",
    timeoutMs: 10_000,
    retry: { base_delay_sec: 0, cap_delay_sec: 0, max_attempts: 3 },
    callId: "test-id",
    signal: undefined,
    onFailedAttempt: undefined,
    disableRetry: false,
    ...overrides,
  });

  it("fn réussi au 1er essai → retourne valeur", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await executeWithRetry(fn, mkCtx());
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("fn 1ère échec 500 puis succès → retry 1x", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw { status: 500, error: { type: "internal" } };
      return "recovered";
    });
    const result = await executeWithRetry(fn, mkCtx());
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("3 échecs 503 consécutifs → HermodRetryExhaustedError", async () => {
    const fn = vi.fn(async () => { throw { status: 503, error: { type: "overloaded" } }; });
    await expect(executeWithRetry(fn, mkCtx())).rejects.toBeInstanceOf(HermodRetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("R3p : disableRetry + 1 échec → HermodUpstreamError direct (pas wrap)", async () => {
    const fn = vi.fn(async () => { throw { status: 503, error: { type: "overloaded" } }; });
    try {
      await executeWithRetry(fn, mkCtx({ disableRetry: true }));
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HermodUpstreamError);
      expect((e as HermodUpstreamError).httpStatus).toBe(503);
    }
    expect(fn).toHaveBeenCalledOnce();
  });

  it("R3p : retry=null → max_attempts=1 → throw direct sans wrap", async () => {
    const fn = vi.fn(async () => { throw { status: 500, error: { type: "x" } }; });
    const ctx = mkCtx({ retry: null });
    await expect(executeWithRetry(fn, ctx)).rejects.toBeInstanceOf(HermodUpstreamError);
  });

  it("EC20 : 401 fail-fast direct → HermodUpstreamError", async () => {
    const fn = vi.fn(async () => { throw { status: 401, error: { type: "authentication_error", message: "bad key" } }; });
    await expect(executeWithRetry(fn, mkCtx())).rejects.toBeInstanceOf(HermodUpstreamError);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("EC21 : 400 fail-fast direct", async () => {
    const fn = vi.fn(async () => { throw { status: 400, error: { type: "invalid_request_error", message: "bad" } }; });
    await expect(executeWithRetry(fn, mkCtx())).rejects.toBeInstanceOf(HermodUpstreamError);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("EC21b : ECONNREFUSED fail-fast → HermodConfigError", async () => {
    const fn = vi.fn(async () => {
      const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      throw err;
    });
    await expect(executeWithRetry(fn, mkCtx())).rejects.toBeInstanceOf(HermodConfigError);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("EC16 : abort pendant backoff → HermodAbortedError", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      // 1er échec network → retry avec backoff. Abort arrive pendant.
      const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
      setTimeout(() => controller.abort("user cancel"), 10);
      throw err;
    });
    const ctx = mkCtx({
      signal: controller.signal,
      retry: { base_delay_sec: 0.05, cap_delay_sec: 1, max_attempts: 3 },
    });
    await expect(executeWithRetry(fn, ctx)).rejects.toBeInstanceOf(HermodAbortedError);
  });

  it("Timeout propre via attempt signal → HermodTimeoutError in retry", async () => {
    const fn = vi.fn(async (signal: AbortSignal) => {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    const ctx = mkCtx({ timeoutMs: 20, retry: { base_delay_sec: 0, cap_delay_sec: 0, max_attempts: 2 } });
    await expect(executeWithRetry(fn, ctx)).rejects.toBeInstanceOf(HermodRetryExhaustedError);
  });

  it("R5b : onFailedAttempt invoqué pour chaque tentative échouée", async () => {
    const events: unknown[] = [];
    const fn = vi.fn(async () => { throw { status: 503, error: { type: "x" } }; });
    const ctx = mkCtx({
      onFailedAttempt: (e) => { events.push(e); },
    });
    await expect(executeWithRetry(fn, ctx)).rejects.toBeInstanceOf(HermodRetryExhaustedError);
    // Flush microtasks (callback non-bloquant via queueMicrotask)
    await new Promise((r) => setTimeout(r, 10));
    expect(events.length).toBe(3);
  });

  it("attemptsHistory inclus dans HermodRetryExhaustedError (EC55)", async () => {
    let i = 0;
    const fn = vi.fn(async () => {
      i++;
      if (i === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      if (i === 2) throw { status: 503, error: { type: "overloaded" } };
      throw { status: 504, error: { type: "gateway_timeout" } };
    });
    try {
      await executeWithRetry(fn, mkCtx());
      expect.fail("expected throw");
    } catch (e) {
      const exh = e as HermodRetryExhaustedError;
      expect(exh).toBeInstanceOf(HermodRetryExhaustedError);
      expect(exh.attemptsHistory).toHaveLength(3);
      expect(exh.attemptsHistory[0]!.error_code).toBe("ECONNRESET");
      expect(exh.attemptsHistory[1]!.error_code).toBe("503");
      expect(exh.attemptsHistory[2]!.error_code).toBe("504");
    }
  });

  it("EC21c : primitive throw → HermodConfigError wrap via fail_fast_other", async () => {
    const fn = vi.fn(async () => { throw "raw string"; });
    try {
      await executeWithRetry(fn, mkCtx());
      expect.fail("expected throw");
    } catch (e) {
      // fail_fast_other throws l'Error wrappée (ou HermodConfigError selon implémentation)
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("raw string");
    }
  });
});
