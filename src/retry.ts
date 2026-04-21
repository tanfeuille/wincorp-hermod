// @spec specs/hermod-client.spec.md v1.2 §4.2 R3* + R5b
//
// Layer de retry custom au-delà du SDK natif.
// Classification stricte via matrice R3d.
// Émission `onFailedAttempt` pour debug batch + reconciliation coûts fantômes.
// Invariant R3p : HermodRetryExhaustedError garanti `attempts >= 2`.

import Anthropic, { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import type { CanonicalModelName, RetryParams } from "@tanfeuille/bragi";
import {
  HermodAbortedError,
  HermodConfigError,
  HermodRetryExhaustedError,
  HermodTimeoutError,
  HermodUpstreamError,
  type AttemptHistoryEntry,
  type HermodLastRetryError,
  type HermodNetworkError,
} from "./errors.js";
import type { FailedAttemptEvent } from "./types.js";

export interface RetryContext {
  readonly canonicalName: CanonicalModelName;
  readonly canonicalId: string;
  readonly timeoutMs: number;
  readonly retry: RetryParams | null;
  readonly callId: string;
  readonly signal?: AbortSignal | undefined;
  readonly onFailedAttempt?: ((event: FailedAttemptEvent) => void | Promise<void>) | undefined;
  readonly disableRetry: boolean;
}

export type FailFastClassification =
  | { kind: "fail_fast_upstream"; httpStatus: number; upstreamCode: string; upstreamMessage: string; cause: unknown }
  | { kind: "fail_fast_abort"; reason: string | undefined }
  | { kind: "fail_fast_connection_refused"; cause: Error }
  | { kind: "fail_fast_other"; cause: unknown };

export type RetryableClassification =
  | { kind: "retryable_timeout"; elapsedMs: number; cause: unknown }
  | { kind: "retryable_network"; errno: HermodNetworkError["errno"]; cause: Error }
  | { kind: "retryable_http"; httpStatus: number; retryAfterMs: number | null; upstreamCode: string; upstreamMessage: string; cause: unknown };

export type Classification = FailFastClassification | RetryableClassification;

// =============================================================================
// Classification erreur
// =============================================================================

const RETRYABLE_NETWORK_ERRNOS = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"]);

/**
 * Extrait le code errno d'une erreur Node (direct ou via `cause`).
 */
function extractErrno(e: unknown): string | null {
  if (e && typeof e === "object") {
    const anyE = e as { code?: unknown; cause?: { code?: unknown } };
    if (typeof anyE.code === "string") return anyE.code;
    if (anyE.cause && typeof anyE.cause === "object" && typeof anyE.cause.code === "string") {
      return anyE.cause.code;
    }
  }
  return null;
}

/**
 * Détecte une AbortError (EC17) via name OU code.
 */
function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (e && typeof e === "object") {
    const anyE = e as { name?: unknown; code?: unknown };
    if (anyE.name === "AbortError") return true;
    if (anyE.code === "ABORT_ERR") return true;
  }
  return false;
}

/**
 * Parse le header `Retry-After` (RFC 7231) — secondes ou HTTP-date.
 * Retourne ms ou null si absent/invalide.
 * HTTP-date avec delta > 60min → null (fail fast).
 * HTTP-date négatif ou < 1s → 1000ms.
 */
export function parseRetryAfter(header: unknown, now = Date.now()): number | null {
  if (typeof header !== "string" || header.length === 0) return null;
  const trimmed = header.trim();

  // Nombre en secondes
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && !Number.isNaN(asNum)) {
    if (asNum < 0) return 0;
    return Math.round(asNum * 1000);
  }

  // HTTP-date
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  let deltaMs = parsed - now + 500; // marge clock skew R3b
  if (deltaMs > 60 * 60 * 1000) return null; // > 60min → fail fast
  if (deltaMs < 1000) return 1000;
  return deltaMs;
}

/**
 * Extrait `Retry-After` d'une erreur SDK Anthropic.
 */
function extractRetryAfter(e: unknown): number | null {
  if (!e || typeof e !== "object") return null;
  const anyE = e as { headers?: unknown; response?: { headers?: unknown } };

  let header: unknown;

  // SDK Anthropic stocke dans error.headers (case-insensitive map ou plain object)
  if (anyE.headers) {
    const h = anyE.headers;
    if (typeof h === "object" && h !== null) {
      // Try Headers instance
      if (typeof (h as { get?: unknown }).get === "function") {
        header = (h as { get: (k: string) => string | null }).get("retry-after");
      } else {
        const plain = h as Record<string, unknown>;
        header = plain["retry-after"] ?? plain["Retry-After"];
      }
    }
  }

  if (header == null && anyE.response?.headers) {
    const h = anyE.response.headers;
    if (typeof (h as { get?: unknown }).get === "function") {
      header = (h as { get: (k: string) => string | null }).get("retry-after");
    } else if (typeof h === "object" && h !== null) {
      const plain = h as Record<string, unknown>;
      header = plain["retry-after"] ?? plain["Retry-After"];
    }
  }

  return parseRetryAfter(header);
}

/**
 * Extrait HTTP status + upstream code/message d'une erreur SDK.
 */
function extractSdkInfo(
  e: unknown,
): { status: number; upstreamCode: string; upstreamMessage: string } | null {
  if (!e || typeof e !== "object") return null;
  const anyE = e as {
    status?: unknown;
    error?: { type?: unknown; message?: unknown };
    message?: unknown;
  };

  const status = typeof anyE.status === "number" ? anyE.status : null;
  if (status === null) return null;

  const upstreamCode =
    typeof anyE.error?.type === "string" ? anyE.error.type : `http_${status}`;
  const upstreamMessage =
    typeof anyE.error?.message === "string"
      ? anyE.error.message
      : typeof anyE.message === "string"
      ? anyE.message
      : "(no message)";

  return { status, upstreamCode, upstreamMessage };
}

/**
 * Classe une erreur selon la matrice R3d.
 */
export function classifyError(e: unknown, signal?: AbortSignal): Classification {
  // 1. Abort (prime sur tout, R3f)
  if (isAbortError(e, signal)) {
    const reason = signal?.reason !== undefined ? String(signal.reason) : undefined;
    return { kind: "fail_fast_abort", reason };
  }

  // 2. Exception primitive (R3l)
  if (typeof e !== "object" || e === null) {
    return {
      kind: "fail_fast_other",
      cause: new Error(typeof e === "string" ? e : String(e)),
    };
  }

  // 3. SDK Anthropic APIConnectionTimeoutError (R3d timeout)
  if (e instanceof APIConnectionTimeoutError) {
    return { kind: "retryable_timeout", elapsedMs: 0, cause: e };
  }

  // 4. SDK APIError avec status HTTP
  const sdkInfo = extractSdkInfo(e);
  if (sdkInfo !== null) {
    const { status, upstreamCode, upstreamMessage } = sdkInfo;

    // Retryables : 408, 429, 5xx sauf 501 (Not Implemented = permanent)
    if (status === 408 || status === 429 || (status >= 500 && status < 600 && status !== 501)) {
      const retryAfterMs = status === 429 ? extractRetryAfter(e) : null;
      return {
        kind: "retryable_http",
        httpStatus: status,
        retryAfterMs,
        upstreamCode,
        upstreamMessage,
        cause: e,
      };
    }

    // Fail-fast 4xx (400, 401, 403, 404, 413, 422, 501, autres)
    return {
      kind: "fail_fast_upstream",
      httpStatus: status,
      upstreamCode,
      upstreamMessage,
      cause: e,
    };
  }

  // 5. Node errno
  const errno = extractErrno(e);
  if (errno === "ECONNREFUSED") {
    return { kind: "fail_fast_connection_refused", cause: e as Error };
  }
  if (errno !== null && RETRYABLE_NETWORK_ERRNOS.has(errno)) {
    return {
      kind: "retryable_network",
      errno: errno as HermodNetworkError["errno"],
      cause: e as Error,
    };
  }

  // 6. Catch-all (TypeError, ReferenceError, autres)
  return { kind: "fail_fast_other", cause: e };
}

// =============================================================================
// Backoff
// =============================================================================

/**
 * Calcule le backoff (ms) pour une tentative donnée.
 * `delay(attempt) = min(base * 2^(attempt-1), cap)` (R3a).
 * `retryAfterMs` prime sur backoff calculé (R3b — cap ignoré si Retry-After > cap).
 */
export function computeBackoffMs(
  attempt: number,
  retry: RetryParams,
  retryAfterMs: number | null,
): number {
  const baseMs = retry.base_delay_sec * 1000;
  const capMs = retry.cap_delay_sec * 1000;
  const expo = Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), capMs);

  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.max(expo, retryAfterMs);
  }

  return expo;
}

/**
 * Wait with AbortSignal support. Rejects with HermodAbortedError if aborted.
 */
export function waitMs(ms: number, signal?: AbortSignal, canonicalName?: CanonicalModelName): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const reason = signal.reason !== undefined ? String(signal.reason) : undefined;
      reject(new HermodAbortedError(canonicalName ?? ("unknown" as CanonicalModelName), reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal?.reason !== undefined ? String(signal.reason) : undefined;
      reject(new HermodAbortedError(canonicalName ?? ("unknown" as CanonicalModelName), reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// =============================================================================
// Invocation callback non-bloquante (R5a)
// =============================================================================

function invokeNonBlocking<E>(
  callback: ((event: E) => void | Promise<void>) | undefined,
  event: E,
): void {
  if (!callback) return;
  queueMicrotask(() => {
    try {
      const result = callback(event);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) => {
          if (process.env["HERMOD_DEBUG"] === "1") {
            // eslint-disable-next-line no-console
            console.error("[hermod] callback async rejection:", err);
          }
        });
      }
    } catch (err) {
      if (process.env["HERMOD_DEBUG"] === "1") {
        // eslint-disable-next-line no-console
        console.error("[hermod] callback sync throw:", err);
      }
    }
  });
}

// =============================================================================
// executeWithRetry — orchestration principale
// =============================================================================

/**
 * Construit un FailedAttemptEvent depuis une classification.
 */
function buildFailedAttemptEvent(
  ctx: RetryContext,
  classification: Classification,
  attempt: number,
  elapsedMs: number,
  willRetry: boolean,
): FailedAttemptEvent {
  const base = {
    call_id: ctx.callId,
    canonical_name: ctx.canonicalName,
    attempt,
    elapsed_ms: elapsedMs,
    will_retry: willRetry,
    timestamp_iso: new Date().toISOString(),
  };

  switch (classification.kind) {
    case "retryable_timeout":
      return {
        ...base,
        reason: "timeout",
        error_code: "APITimeoutError",
        http_status: undefined,
        retry_after_ms: undefined,
      };
    case "retryable_network":
      return {
        ...base,
        reason: "network",
        error_code: classification.errno,
        http_status: undefined,
        retry_after_ms: undefined,
      };
    case "retryable_http":
      return {
        ...base,
        reason: classification.httpStatus === 429 ? "429" : "5xx",
        error_code: String(classification.httpStatus),
        http_status: classification.httpStatus,
        retry_after_ms: classification.retryAfterMs ?? undefined,
      };
    case "fail_fast_connection_refused":
      return {
        ...base,
        reason: "connection_refused",
        error_code: "ECONNREFUSED",
        http_status: undefined,
        retry_after_ms: undefined,
      };
    case "fail_fast_abort":
      return {
        ...base,
        reason: "abort",
        error_code: "AbortError",
        http_status: undefined,
        retry_after_ms: undefined,
      };
    case "fail_fast_other":
      return {
        ...base,
        reason: "other",
        error_code: (classification.cause as Error)?.name ?? "UnknownError",
        http_status: undefined,
        retry_after_ms: undefined,
      };
    case "fail_fast_upstream":
      // Pas d'event émis pour 4xx fail-fast (cf R5b table). Appelant gère.
      // Cette branche n'est jamais appelée en pratique (guard dans executeWithRetry).
      return {
        ...base,
        reason: "other",
        error_code: String(classification.httpStatus),
        http_status: classification.httpStatus,
        retry_after_ms: undefined,
      };
  }
}

/**
 * Construit un AttemptHistoryEntry pour log final.
 */
function buildHistoryEntry(
  classification: Classification,
  attempt: number,
  elapsedMs: number,
): AttemptHistoryEntry {
  const truncate = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s);

  switch (classification.kind) {
    case "retryable_timeout":
      return {
        attempt,
        elapsed_ms: elapsedMs,
        error_code: "APITimeoutError",
        error_message: truncate(String((classification.cause as Error)?.message ?? "timeout")),
        http_status: undefined,
      };
    case "retryable_network":
      return {
        attempt,
        elapsed_ms: elapsedMs,
        error_code: classification.errno,
        error_message: truncate(classification.cause.message ?? classification.errno),
        http_status: undefined,
      };
    case "retryable_http":
      return {
        attempt,
        elapsed_ms: elapsedMs,
        error_code: String(classification.httpStatus),
        error_message: truncate(classification.upstreamMessage),
        http_status: classification.httpStatus,
      };
    case "fail_fast_connection_refused":
      return {
        attempt,
        elapsed_ms: elapsedMs,
        error_code: "ECONNREFUSED",
        error_message: truncate(classification.cause.message ?? "connection refused"),
        http_status: undefined,
      };
    case "fail_fast_abort":
      return {
        attempt,
        elapsed_ms: elapsedMs,
        error_code: "AbortError",
        error_message: truncate(classification.reason ?? "aborted"),
        http_status: undefined,
      };
    case "fail_fast_other":
      return {
        attempt,
        elapsed_ms: elapsedMs,
        error_code: (classification.cause as Error)?.name ?? "UnknownError",
        error_message: truncate(String((classification.cause as Error)?.message ?? classification.cause)),
        http_status: undefined,
      };
    case "fail_fast_upstream":
      return {
        attempt,
        elapsed_ms: elapsedMs,
        error_code: String(classification.httpStatus),
        error_message: truncate(classification.upstreamMessage),
        http_status: classification.httpStatus,
      };
  }
}

/**
 * Convertit une classification retryable ou timeout en HermodLastRetryError
 * pour inclusion dans HermodRetryExhaustedError.lastError.
 */
function toLastRetryError(
  ctx: RetryContext,
  classification: Classification,
  attempt: number,
  elapsedMs: number,
): HermodLastRetryError {
  switch (classification.kind) {
    case "retryable_timeout":
      return new HermodTimeoutError(
        ctx.canonicalName,
        ctx.canonicalId,
        ctx.timeoutMs,
        elapsedMs,
        attempt,
      );
    case "retryable_network":
      return {
        code: "HERMOD_NETWORK_ERROR",
        errno: classification.errno,
        cause: classification.cause,
      };
    case "retryable_http":
      return new HermodUpstreamError(
        ctx.canonicalName,
        classification.httpStatus,
        classification.upstreamCode,
        classification.upstreamMessage,
        classification.cause,
      );
    default:
      // Ne devrait pas arriver — les fail_fast throw direct avant d'arriver ici.
      throw new Error(`toLastRetryError: unexpected classification ${classification.kind}`);
  }
}

/**
 * Exécute une fonction avec retry custom selon la config bragi.
 */
export async function executeWithRetry<T>(
  fn: (attemptSignal: AbortSignal) => Promise<T>,
  ctx: RetryContext,
): Promise<T> {
  const maxAttempts = ctx.disableRetry ? 1 : ctx.retry?.max_attempts ?? 1;
  const startTime = performance.now();
  const history: AttemptHistoryEntry[] = [];

  let lastClassification: Classification | null = null;
  let lastElapsedMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctx.signal?.aborted) {
      const reason = ctx.signal.reason !== undefined ? String(ctx.signal.reason) : undefined;
      throw new HermodAbortedError(ctx.canonicalName, reason);
    }

    const attemptStart = performance.now();
    const attemptController = new AbortController();
    const timeoutHandle = setTimeout(() => attemptController.abort("timeout"), ctx.timeoutMs);

    // Link external signal to attempt controller
    const onParentAbort = () => {
      clearTimeout(timeoutHandle);
      attemptController.abort(ctx.signal?.reason);
    };
    ctx.signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const result = await fn(attemptController.signal);
      clearTimeout(timeoutHandle);
      ctx.signal?.removeEventListener("abort", onParentAbort);
      return result;
    } catch (e) {
      clearTimeout(timeoutHandle);
      ctx.signal?.removeEventListener("abort", onParentAbort);

      const elapsedMs = performance.now() - attemptStart;
      lastElapsedMs = elapsedMs;

      // If the parent signal was aborted, prioritize that (map to abort, not timeout)
      if (ctx.signal?.aborted) {
        const reason = ctx.signal.reason !== undefined ? String(ctx.signal.reason) : undefined;
        // Emit abort event
        invokeNonBlocking(ctx.onFailedAttempt, buildFailedAttemptEvent(
          ctx,
          { kind: "fail_fast_abort", reason },
          attempt,
          elapsedMs,
          false,
        ));
        throw new HermodAbortedError(ctx.canonicalName, reason);
      }

      // Timeout from our attempt controller (not parent abort)
      const isOurTimeout = attemptController.signal.aborted && attemptController.signal.reason === "timeout";
      const classification: Classification = isOurTimeout
        ? { kind: "retryable_timeout", elapsedMs, cause: e }
        : classifyError(e, ctx.signal);

      lastClassification = classification;
      history.push(buildHistoryEntry(classification, attempt, elapsedMs));

      // Fail-fast classifications
      if (classification.kind === "fail_fast_upstream") {
        // Pas de FailedAttemptEvent (selon R5b table), throw direct
        throw new HermodUpstreamError(
          ctx.canonicalName,
          classification.httpStatus,
          classification.upstreamCode,
          classification.upstreamMessage,
          classification.cause,
        );
      }
      if (classification.kind === "fail_fast_connection_refused") {
        invokeNonBlocking(
          ctx.onFailedAttempt,
          buildFailedAttemptEvent(ctx, classification, attempt, elapsedMs, false),
        );
        throw new HermodConfigError(
          `Connection refused — vérifier ANTHROPIC_BASE_URL (ou configuration réseau). Cause : ${classification.cause.message}`,
          classification.cause,
          ctx.canonicalName,
        );
      }
      if (classification.kind === "fail_fast_abort") {
        invokeNonBlocking(
          ctx.onFailedAttempt,
          buildFailedAttemptEvent(ctx, classification, attempt, elapsedMs, false),
        );
        throw new HermodAbortedError(ctx.canonicalName, classification.reason);
      }
      if (classification.kind === "fail_fast_other") {
        invokeNonBlocking(
          ctx.onFailedAttempt,
          buildFailedAttemptEvent(ctx, classification, attempt, elapsedMs, false),
        );
        // Throw wrapped native error (primitive rewrapped or TypeError etc.)
        if (classification.cause instanceof Error) throw classification.cause;
        throw new Error(String(classification.cause));
      }

      // Retryable — decide whether to retry
      const hasMoreAttempts = attempt < maxAttempts;

      invokeNonBlocking(
        ctx.onFailedAttempt,
        buildFailedAttemptEvent(ctx, classification, attempt, elapsedMs, hasMoreAttempts),
      );

      if (!hasMoreAttempts) {
        break; // Sort de la boucle, throw final après
      }

      // Backoff + retry
      const retryAfterMs =
        classification.kind === "retryable_http" ? classification.retryAfterMs : null;
      const backoffMs = ctx.retry
        ? computeBackoffMs(attempt, ctx.retry, retryAfterMs)
        : 0;

      if (backoffMs > 0) {
        await waitMs(backoffMs, ctx.signal, ctx.canonicalName);
      }
    }
  }

  // Post-loop : throw final
  const totalElapsedMs = performance.now() - startTime;

  if (lastClassification === null) {
    throw new Error("executeWithRetry: no classification after loop — this is a bug");
  }

  // R3p : si attempt 1 échec sans retry possible, throw direct (pas wrap RetryExhausted)
  if (history.length === 1 && maxAttempts === 1) {
    switch (lastClassification.kind) {
      case "retryable_timeout":
        throw new HermodTimeoutError(
          ctx.canonicalName,
          ctx.canonicalId,
          ctx.timeoutMs,
          lastElapsedMs,
          1,
        );
      case "retryable_network":
        throw new HermodConfigError(
          `Erreur réseau ${lastClassification.errno} au premier essai (retry désactivé).`,
          lastClassification.cause,
          ctx.canonicalName,
        );
      case "retryable_http":
        throw new HermodUpstreamError(
          ctx.canonicalName,
          lastClassification.httpStatus,
          lastClassification.upstreamCode,
          lastClassification.upstreamMessage,
          lastClassification.cause,
        );
      default:
        // Les fail_fast ont déjà throw plus haut
        throw new Error(`executeWithRetry R3p: unexpected classification ${lastClassification.kind}`);
    }
  }

  // attempts >= 2 : wrap HermodRetryExhaustedError
  const lastError = toLastRetryError(ctx, lastClassification, history.length, lastElapsedMs);
  throw new HermodRetryExhaustedError(
    ctx.canonicalName,
    history.length,
    lastError,
    totalElapsedMs,
    history,
  );
}
