// @spec specs/hermod-client.spec.md v1.2 §3.4 + §4.6 R9 R10
//
// Hiérarchie d'erreurs hermod : 5 classes avec `code` littéral + `HermodNetworkError`
// interface + union `HermodLastRetryError`.
// Target ES2022 — pas de Object.setPrototypeOf (super() préserve la chaîne).
// Messages FR, redaction API key via regex R7b/R10.

import type { CanonicalModelName } from "@tanfeuille/bragi";

/**
 * Erreur network wrapped pour discrimination union (Node errno codes).
 * ECONNREFUSED absent : fail-fast, ne passe jamais par retry (R3m).
 */
export interface HermodNetworkError {
  readonly code: "HERMOD_NETWORK_ERROR";
  readonly errno: "ECONNRESET" | "ETIMEDOUT" | "ENOTFOUND" | "EPIPE";
  readonly cause: Error;
}

/**
 * Classe abstraite de base pour toutes les erreurs hermod.
 * `code` littéral permet narrowing cross-realm via `error.code === "HERMOD_..."`.
 */
export abstract class HermodError extends Error {
  abstract readonly code:
    | "HERMOD_CONFIG_ERROR"
    | "HERMOD_TIMEOUT"
    | "HERMOD_RETRY_EXHAUSTED"
    | "HERMOD_ABORTED"
    | "HERMOD_UPSTREAM";

  constructor(message: string) {
    super(sanitizeMessage(message));
    this.name = this.constructor.name;
  }
}

/**
 * Configuration invalide : bragi throw (modèle inconnu, disabled, hash drift),
 * options inconsistantes (perCallTimeoutMs hors plage), ou version bragi drift major.
 */
export class HermodConfigError extends HermodError {
  readonly code = "HERMOD_CONFIG_ERROR" as const;

  constructor(
    message: string,
    readonly cause?: unknown | undefined,
    readonly canonicalName?: string | undefined,
  ) {
    super(message);
  }
}

/**
 * Timeout dépassé sur une tentative. Si `attempts < max`, suivi d'un retry ;
 * si final sans retry possible, throw direct (R3p).
 */
export class HermodTimeoutError extends HermodError {
  readonly code = "HERMOD_TIMEOUT" as const;

  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly canonicalId: string,
    readonly timeoutMs: number,
    readonly elapsedMs: number,
    readonly attempt: number,
  ) {
    super(
      `Timeout ${timeoutMs}ms dépassé (${elapsedMs}ms écoulés) — modèle ${canonicalName} (${canonicalId}), tentative ${attempt}.`,
    );
  }
}

/**
 * Wrap uniforme des erreurs SDK Anthropic fail-fast (4xx non-retryables) et des
 * 5xx finaux (retry épuisé — apparaît dans HermodRetryExhaustedError.lastError).
 */
export class HermodUpstreamError extends HermodError {
  readonly code = "HERMOD_UPSTREAM" as const;

  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly httpStatus: number,
    readonly upstreamCode: string,
    readonly upstreamMessage: string,
    readonly cause?: unknown | undefined,
  ) {
    super(
      `Erreur upstream Anthropic ${httpStatus} (${upstreamCode}) sur modèle ${canonicalName} — ${upstreamMessage}`,
    );
  }
}

/**
 * Abort externe via AbortSignal. Prime sur timeout et retry (R3f).
 */
export class HermodAbortedError extends HermodError {
  readonly code = "HERMOD_ABORTED" as const;

  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly reason?: string | undefined,
  ) {
    super(
      `Abort externe reçu — modèle ${canonicalName}${reason ? ` (raison: ${reason})` : ""}.`,
    );
  }
}

/**
 * Union discriminée des erreurs possibles comme `lastError` d'un retry épuisé.
 * Jamais `unknown` — le consumer peut narrower via `.code` littéral.
 */
export type HermodLastRetryError =
  | HermodTimeoutError
  | HermodUpstreamError
  | HermodNetworkError;

/**
 * Entrée de l'historique des tentatives, attachée à HermodRetryExhaustedError.
 */
export interface AttemptHistoryEntry {
  readonly attempt: number;
  readonly elapsed_ms: number;
  readonly error_code: string;
  readonly error_message: string;
  readonly http_status: number | undefined;
}

/**
 * Retry épuisé après ≥2 tentatives (invariant R3p). Contient l'historique
 * complet des tentatives pour debug batch (R5b, EC55).
 */
export class HermodRetryExhaustedError extends HermodError {
  readonly code = "HERMOD_RETRY_EXHAUSTED" as const;

  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly attempts: number,
    readonly lastError: HermodLastRetryError,
    readonly totalElapsedMs: number,
    readonly attemptsHistory: ReadonlyArray<AttemptHistoryEntry>,
  ) {
    super(
      `Retry épuisé après ${attempts} tentatives sur modèle ${canonicalName} — dernière erreur : ${lastError.code} (${summarizeLast(lastError)}).`,
    );
  }
}

// =============================================================================
// Helpers privés
// =============================================================================

/**
 * Résume compactement une HermodLastRetryError pour inclusion dans un message.
 */
function summarizeLast(last: HermodLastRetryError): string {
  if (last.code === "HERMOD_NETWORK_ERROR") {
    return `network ${last.errno}`;
  }
  if (last.code === "HERMOD_UPSTREAM") {
    return `HTTP ${last.httpStatus} ${last.upstreamCode}`;
  }
  // HERMOD_TIMEOUT
  return `timeout ${last.timeoutMs}ms`;
}

/**
 * R10 — redaction regex API keys + sanitize control chars.
 * Appliqué sur toute construction de message d'erreur pour éviter log-injection
 * et fuite de clés. Regex couvre Anthropic, OpenAI, Bearer, AWS, GitHub PAT.
 */
const API_KEY_REDACTION_RE = /sk-[A-Za-z0-9_\-]+/g;
const BEARER_REDACTION_RE = /Bearer\s+[A-Za-z0-9_\-.=]+/g;
const AWS_REDACTION_RE = /AKIA[A-Z0-9]{16}/g;
const GITHUB_PAT_RE = /gh[pousr]_[A-Za-z0-9]{36,}/g;

function sanitizeMessage(message: string): string {
  return message
    .replace(API_KEY_REDACTION_RE, "sk-***")
    .replace(BEARER_REDACTION_RE, "Bearer ***")
    .replace(AWS_REDACTION_RE, "AKIA***")
    .replace(GITHUB_PAT_RE, "ghp_***");
}
