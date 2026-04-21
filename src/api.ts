// @spec specs/hermod-client.spec.md v1.2 §3.2
//
// Surface publique api :
// - createClient (from ./client.js)
// - calculateCost (from ./metrics.js)
// - isHermodError whitelist exhaustive (R2a anti pollution)
// - isAnthropicSdkError

import { APIError } from "@anthropic-ai/sdk";
import { HermodError } from "./errors.js";

export { createClient } from "./client.js";
export { calculateCost } from "./metrics.js";

/**
 * Whitelist exhaustive des codes d'erreur hermod connus.
 * Utilisée par isHermodError pour empêcher pollution `{code:"HERMOD_FAKE"}`.
 */
const KNOWN_HERMOD_CODES: ReadonlySet<string> = new Set([
  "HERMOD_CONFIG_ERROR",
  "HERMOD_TIMEOUT",
  "HERMOD_RETRY_EXHAUSTED",
  "HERMOD_ABORTED",
  "HERMOD_UPSTREAM",
]);

/**
 * Type guard strict pour erreurs hermod.
 * Retourne true si :
 *   - e instanceof HermodError (cas nominal même realm)
 *   - OU e est un objet avec `code: string` ET `code` ∈ KNOWN_HERMOD_CODES
 *     (cas cross-realm : multiples versions de hermod via deps transitives).
 *
 * Anti pollution : refuse `{code:"HERMOD_FAKE"}` ou toute chaîne non-whitelistée.
 */
export function isHermodError(e: unknown): e is HermodError {
  if (e instanceof HermodError) return true;
  if (e && typeof e === "object" && "code" in e) {
    const code = (e as { code: unknown }).code;
    if (typeof code === "string" && KNOWN_HERMOD_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

/**
 * Type guard pour erreurs SDK Anthropic (passthrough streaming/batches/parse
 * ou erreurs non-classées hermod).
 * Retourne true si e instanceof APIError OU structurellement reconnu
 * (e.status: number + e.error.type: string).
 */
export function isAnthropicSdkError(e: unknown): e is APIError {
  if (e instanceof APIError) return true;
  if (e && typeof e === "object") {
    const anyE = e as { status?: unknown; error?: { type?: unknown } };
    if (typeof anyE.status === "number" && anyE.error && typeof anyE.error === "object") {
      return typeof anyE.error.type === "string";
    }
  }
  return false;
}
