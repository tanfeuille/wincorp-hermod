// @spec specs/hermod-client.spec.md v1.2 §3.1
//
// Surface publique de `@tanfeuille/hermod`.

// Fonctions publiques
export { createClient, calculateCost, isHermodError, isAnthropicSdkError } from "./api.js";

// Erreurs
export {
  HermodError,
  HermodConfigError,
  HermodTimeoutError,
  HermodRetryExhaustedError,
  HermodAbortedError,
  HermodUpstreamError,
} from "./errors.js";

// Types publics
export type {
  HermodClient,
  HermodClientOptions,
  HermodMessageCreateParams,
  FailedAttemptEvent,
} from "./types.js";

export type {
  HermodLastRetryError,
  HermodNetworkError,
  AttemptHistoryEntry,
} from "./errors.js";

// Re-export shared types from bragi pour ergonomie consumer
export type { UsageEvent, CanonicalModelName } from "@tanfeuille/bragi";

// Constantes de traçabilité (build-time via sync-bragi)
export {
  HERMOD_VERSION,
  HERMOD_BRAGI_VERSION,
  HERMOD_BRAGI_URD_HASH,
  HERMOD_BRAGI_URD_DATE,
  HERMOD_SDK_VERSION,
  HERMOD_BUILD_AT,
} from "./metadata.generated.js";
