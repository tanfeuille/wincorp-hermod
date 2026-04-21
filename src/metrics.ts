// @spec specs/hermod-client.spec.md v1.2 §4.4 R5 R6
//
// Métriques hermod :
// - calculateCost : pure, via bragi.getPricing (R6)
// - emitUsageEvent : invocation non-bloquante queueMicrotask (R5a)
// - Guards R6c anti valeurs aberrantes

import type Anthropic from "@anthropic-ai/sdk";
import type { CanonicalModelName, UsageEvent } from "@tanfeuille/bragi";
import { getPricing, getModelId } from "@tanfeuille/bragi";
import { HermodConfigError } from "./errors.js";

const MAX_TOKENS_PLAFOND = 10_000_000;

/**
 * Calcule le coût EUR d'un appel Anthropic depuis usage + canonicalName.
 * Formule : (input_tokens * input_per_M + output_tokens * output_per_M) / 1e6.
 * Round final à 6 décimales (pas d'arrondi intermédiaire, R6a).
 *
 * @throws HermodConfigError si bragi throw (canonicalName inconnu/disabled) OU
 *         si usage contient valeurs négatives/NaN/Infinity/overflow (R6c).
 */
export function calculateCost(
  usage: Anthropic.Messages.Usage | null | undefined,
  canonicalName: CanonicalModelName,
): number {
  // Usage null/undefined/empty → 0 (pas throw, R6)
  if (usage == null) return 0;

  const input = usage.input_tokens;
  const output = usage.output_tokens;

  // Guard R6c — inputs valides
  validateTokenCount(input, "input_tokens", canonicalName);
  validateTokenCount(output, "output_tokens", canonicalName);

  const inputSafe = typeof input === "number" ? input : 0;
  const outputSafe = typeof output === "number" ? output : 0;

  let pricing;
  try {
    pricing = getPricing(canonicalName);
  } catch (e) {
    throw new HermodConfigError(
      `Impossible de calculer le coût : bragi.getPricing a échoué.`,
      e,
      canonicalName,
    );
  }

  const inputM = inputSafe / 1_000_000;
  const outputM = outputSafe / 1_000_000;
  const total = inputM * pricing.input_per_million_eur + outputM * pricing.output_per_million_eur;

  return Math.round(total * 1_000_000) / 1_000_000;
}

/**
 * Valide une valeur token count — retourne silencieusement si undefined/0,
 * throw HermodConfigError si négatif/NaN/Infinity/overflow.
 */
function validateTokenCount(
  v: unknown,
  fieldName: string,
  canonicalName: CanonicalModelName,
): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "number") {
    throw new HermodConfigError(
      `Usage anormal : ${fieldName} n'est pas un nombre (type ${typeof v}).`,
      undefined,
      canonicalName,
    );
  }
  if (Number.isNaN(v)) {
    throw new HermodConfigError(
      `Usage anormal : ${fieldName} = NaN.`,
      undefined,
      canonicalName,
    );
  }
  if (!Number.isFinite(v)) {
    throw new HermodConfigError(
      `Usage anormal : ${fieldName} = Infinity.`,
      undefined,
      canonicalName,
    );
  }
  if (v < 0) {
    throw new HermodConfigError(
      `Usage anormal : ${fieldName} négatif (${v}) — corruption SDK.`,
      undefined,
      canonicalName,
    );
  }
  if (v > MAX_TOKENS_PLAFOND) {
    throw new HermodConfigError(
      `Usage anormal : ${fieldName} = ${v} > ${MAX_TOKENS_PLAFOND} — vérifier SDK.`,
      undefined,
      canonicalName,
    );
  }
}

export interface UsageEventContext {
  readonly callId: string;
  readonly canonicalName: CanonicalModelName;
  readonly durationMs: number;
  readonly timestampIso: string;
}

/**
 * Construit un UsageEvent à partir du response.usage SDK.
 */
export function buildUsageEvent(
  usage: Anthropic.Messages.Usage,
  ctx: UsageEventContext,
): UsageEvent {
  const canonicalId = getModelId(ctx.canonicalName);
  const cost = calculateCost(usage, ctx.canonicalName);

  return {
    call_id: ctx.callId,
    canonical_name: ctx.canonicalName,
    canonical_id: canonicalId,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cost_eur: cost,
    duration_ms: ctx.durationMs,
    timestamp_iso: ctx.timestampIso,
  };
}

/**
 * Invoque onUsage de manière non-bloquante via queueMicrotask (R5a).
 * Exceptions sync catchées + log debug, Promise reject attrapée via .catch().
 * Jamais propagée au consumer.
 */
export function emitUsageEvent(
  onUsage: ((event: UsageEvent) => void | Promise<void>) | undefined,
  event: UsageEvent,
): void {
  if (!onUsage) return;
  queueMicrotask(() => {
    try {
      const result = onUsage(event);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) => {
          if (process.env["HERMOD_DEBUG"] === "1") {
            // eslint-disable-next-line no-console
            console.error("[hermod] onUsage async rejection:", err);
          }
        });
      }
    } catch (err) {
      if (process.env["HERMOD_DEBUG"] === "1") {
        // eslint-disable-next-line no-console
        console.error("[hermod] onUsage sync throw:", err);
      }
    }
  });
}
