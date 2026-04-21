// @spec specs/hermod-client.spec.md v1.2 §4.4 R5 R6

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CanonicalModelName, UsageEvent } from "@tanfeuille/bragi";
import { calculateCost, buildUsageEvent, emitUsageEvent } from "../src/metrics.js";
import { HermodConfigError } from "../src/errors.js";

const SONNET = "claude-sonnet" as CanonicalModelName;

afterEach(() => {
  delete process.env["HERMOD_DEBUG"];
});

describe("calculateCost (R6)", () => {
  it("nominal : input + output tokens × pricing", () => {
    // Sonnet pricing : 2.76 EUR/M in, 13.80 EUR/M out
    const cost = calculateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, SONNET);
    expect(cost).toBeCloseTo(2.76 + 13.80, 5);
  });

  it("EC6 : null → 0", () => {
    expect(calculateCost(null, SONNET)).toBe(0);
  });

  it("EC6 : undefined → 0", () => {
    expect(calculateCost(undefined, SONNET)).toBe(0);
  });

  it("EC7 : usage vide → 0", () => {
    expect(calculateCost({} as never, SONNET)).toBe(0);
  });

  it("partiel : seul input_tokens", () => {
    const cost = calculateCost({ input_tokens: 500_000 } as never, SONNET);
    expect(cost).toBeCloseTo(2.76 * 0.5, 5);
  });

  it("partiel : seul output_tokens", () => {
    const cost = calculateCost({ output_tokens: 500_000 } as never, SONNET);
    expect(cost).toBeCloseTo(13.80 * 0.5, 5);
  });

  it("R6a : round final 6 décimales", () => {
    const cost = calculateCost({ input_tokens: 123, output_tokens: 456 }, SONNET);
    const expected = (123 * 2.76 + 456 * 13.80) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 6);
    const decimals = cost.toString().split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  it("EC8 R6c : input_tokens négatif → throw", () => {
    expect(() => calculateCost({ input_tokens: -1, output_tokens: 100 } as never, SONNET)).toThrow(
      HermodConfigError,
    );
  });

  it("EC8 R6c : output_tokens négatif → throw", () => {
    expect(() => calculateCost({ input_tokens: 100, output_tokens: -1 } as never, SONNET)).toThrow(
      HermodConfigError,
    );
  });

  it("EC8 R6c : deux négatifs → throw", () => {
    expect(() => calculateCost({ input_tokens: -5, output_tokens: -3 } as never, SONNET)).toThrow(
      HermodConfigError,
    );
  });

  it("EC9 R6c : NaN → throw", () => {
    expect(() => calculateCost({ input_tokens: NaN, output_tokens: 1 } as never, SONNET)).toThrow(
      HermodConfigError,
    );
  });

  it("EC9 R6c : Infinity → throw", () => {
    expect(() => calculateCost({ input_tokens: Infinity, output_tokens: 1 } as never, SONNET)).toThrow(
      HermodConfigError,
    );
  });

  it("EC9 R6c : overflow > 10M → throw", () => {
    expect(() => calculateCost({ input_tokens: 20_000_000, output_tokens: 1 } as never, SONNET)).toThrow(
      HermodConfigError,
    );
  });

  it("R6c : accepte 10M pile (limite haute)", () => {
    expect(() => calculateCost({ input_tokens: 10_000_000, output_tokens: 0 } as never, SONNET)).not.toThrow();
  });

  it("R2 : bragi throw propagé en HermodConfigError", () => {
    // @ts-expect-error — nom invalide délibéré
    expect(() => calculateCost({ input_tokens: 100, output_tokens: 100 }, "fake-name")).toThrow(
      HermodConfigError,
    );
  });
});

describe("buildUsageEvent", () => {
  it("construit UsageEvent avec cost calculé", () => {
    const event = buildUsageEvent(
      { input_tokens: 1_000_000, output_tokens: 0 },
      {
        callId: "abc-123",
        canonicalName: SONNET,
        durationMs: 1500,
        timestampIso: "2026-04-21T20:00:00Z",
      },
    );
    expect(event.call_id).toBe("abc-123");
    expect(event.canonical_name).toBe(SONNET);
    expect(event.canonical_id).toBe("claude-sonnet-4-6");
    expect(event.input_tokens).toBe(1_000_000);
    expect(event.cost_eur).toBeCloseTo(2.76, 5);
    expect(event.duration_ms).toBe(1500);
    expect(event.timestamp_iso).toBe("2026-04-21T20:00:00Z");
  });

  it("usage avec tokens undefined → 0 dans event", () => {
    const event = buildUsageEvent(
      {} as never,
      { callId: "id", canonicalName: SONNET, durationMs: 10, timestampIso: "now" },
    );
    expect(event.input_tokens).toBe(0);
    expect(event.output_tokens).toBe(0);
    expect(event.cost_eur).toBe(0);
  });
});

describe("emitUsageEvent (R5a)", () => {
  const makeEvent = (): UsageEvent => ({
    canonical_name: SONNET,
    canonical_id: "claude-sonnet-4-6" as never,
    input_tokens: 0,
    output_tokens: 0,
    cost_eur: 0,
    duration_ms: 0,
    timestamp_iso: "now",
  });

  it("undefined callback → no-op", () => {
    expect(() => emitUsageEvent(undefined, makeEvent())).not.toThrow();
  });

  it("sync callback appelé via queueMicrotask", async () => {
    const spy = vi.fn();
    emitUsageEvent(spy, makeEvent());
    expect(spy).not.toHaveBeenCalled(); // queueMicrotask n'est pas sync
    await Promise.resolve(); // flush microtasks
    expect(spy).toHaveBeenCalledOnce();
  });

  it("sync throw ne propage pas (EC31)", async () => {
    const spy = vi.fn(() => { throw new Error("boom"); });
    expect(() => emitUsageEvent(spy, makeEvent())).not.toThrow();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("async reject ne propage pas (EC32)", async () => {
    const spy = vi.fn(async () => { throw new Error("async boom"); });
    expect(() => emitUsageEvent(spy, makeEvent())).not.toThrow();
    // Flush microtasks pour laisser le catch interne attraper la Promise
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledOnce();
    // Test passe si pas d'unhandledRejection ni de process.exit
  });

  it("callback reçoit l'event complet", async () => {
    const spy = vi.fn();
    const event = makeEvent();
    emitUsageEvent(spy, event);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith(event);
  });
});
