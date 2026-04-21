// @spec specs/hermod-client.spec.md v1.2 §3.3
//
// Types publics hermod :
// - HermodClient (phantom brand + Omit model)
// - HermodClientOptions
// - HermodMessageCreateParams
// - FailedAttemptEvent (mapping R5b)
//
// Les classes d'erreurs, HermodNetworkError, HermodLastRetryError et
// AttemptHistoryEntry vivent dans errors.ts pour éviter import circulaire.

import type Anthropic from "@anthropic-ai/sdk";
import type { CanonicalModelName, UsageEvent } from "@tanfeuille/bragi";

/**
 * Phantom brand symbol — empêche qu'une instance SDK nue soit assignable à
 * HermodClient. Stampé runtime par le Proxy sur l'objet `messages` (R11d).
 * Non exporté publiquement — le consumer ne manipule jamais ce symbol.
 */
export declare const HermodClientBrand: unique symbol;

/**
 * Params de messages.create() sans `model` (injecté par hermod via Proxy R2d).
 * Le consumer ne peut PAS passer `model:` ou `stream: true` — typage l'interdit
 * structurellement via MessageCreateParamsNonStreaming.
 */
export type HermodMessageCreateParams = Omit<
  Anthropic.Messages.MessageCreateParamsNonStreaming,
  "model"
>;

/**
 * Client hermod. Distinct structurellement ET nominalement d'Anthropic SDK.
 *
 * Distinction structurelle : `messages.create` param Omit<..., "model"> —
 * contravariance empêche `new Anthropic()` d'être assigné à HermodClient.
 *
 * Distinction nominale (phantom brand) : `messages[HermodClientBrand]: true`
 * stampé runtime par le Proxy. Empêche le cast explicite
 * `new Anthropic() as unknown as HermodClient`.
 *
 * Surface `messages` :
 *   - `create` : wrappé (injection model + retry custom + callbacks).
 *   - `stream`, `countTokens`, `batches`, `parse` : passthrough SDK direct
 *     (pas d'injection, pas de retry hermod, pas de callbacks — §1 exception
 *     assumée à l'invariant).
 *
 * Autres propriétés top-level (beta, etc.) : héritées via Omit<Anthropic, "messages">.
 */
export interface HermodClient extends Omit<Anthropic, "messages"> {
  readonly messages: {
    readonly [HermodClientBrand]: true;
    create(
      params: HermodMessageCreateParams,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Messages.Message>;
    stream: Anthropic["messages"]["stream"];
    countTokens: Anthropic["messages"]["countTokens"];
    batches: Anthropic["messages"]["batches"];
  };
}

/**
 * Options de createClient.
 * Tous les champs sont `?: T | undefined` explicites pour cohabiter avec
 * `exactOptionalPropertyTypes: true` (M-9).
 */
export interface HermodClientOptions {
  /**
   * Callback invoqué après chaque messages.create() réussi (HTTP 2xx).
   * Non-bloquant : exception sync catchée + log debug, Promise reject
   * attrapée via .catch() explicite (R5a). Jamais propagée.
   */
  readonly onUsage?: ((event: UsageEvent) => void | Promise<void>) | undefined;

  /**
   * Callback invoqué pour chaque tentative échouée (retry ou fail final).
   * Utile à la reconciliation coûts fantômes. Même contrat non-bloquant que onUsage.
   */
  readonly onFailedAttempt?: ((event: FailedAttemptEvent) => void | Promise<void>) | undefined;

  /** AbortSignal propagé au SDK. Prime sur timeout/retry (R3f). */
  readonly signal?: AbortSignal | undefined;

  /** Override baseURL SDK (prime sur ANTHROPIC_BASE_URL env). */
  readonly baseURL?: string | undefined;

  /** Override API key (déconseillé en prod). */
  readonly apiKey?: string | undefined;

  /**
   * Override timeout pour cet appel. Cap = bragi.timeout_sec * 1000.
   * Si > cap, tronqué + warning debug (R4a).
   * Si < 1 ou non-number, HermodConfigError au createClient.
   */
  readonly perCallTimeoutMs?: number | undefined;
}

/**
 * Event émis pour chaque tentative échouée sur messages.create().
 *
 * Mapping `reason` exhaustif (anti-"other" silencieux) :
 *   - "timeout"            : APITimeoutError SDK ou HermodTimeoutError
 *   - "network"            : errno ∈ {ECONNRESET, ETIMEDOUT, ENOTFOUND, EPIPE}
 *   - "connection_refused" : errno ECONNREFUSED (fail-fast, un seul event)
 *   - "429"                : HTTP 429 Too Many Requests
 *   - "5xx"                : HTTP 408, 500, 502, 503, 504, autres 5xx
 *   - "abort"              : AbortSignal reçu
 *   - "other"              : exception non classée (bug code)
 */
export interface FailedAttemptEvent {
  readonly call_id: string;
  readonly canonical_name: CanonicalModelName;
  readonly attempt: number;
  readonly elapsed_ms: number;
  readonly reason:
    | "timeout"
    | "network"
    | "connection_refused"
    | "429"
    | "5xx"
    | "abort"
    | "other";
  readonly error_code: string;
  readonly http_status: number | undefined;
  readonly retry_after_ms: number | undefined;
  readonly will_retry: boolean;
  readonly timestamp_iso: string;
}
