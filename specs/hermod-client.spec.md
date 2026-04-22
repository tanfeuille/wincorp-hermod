# `wincorp_hermod.hermod-client` — Specification

> **Statut :** IMPLEMENTED (v0.1.2 publié GitHub Packages 22/04/2026, consommé par thor + bifrost, audit 3 agents downstream validé)
> **Version :** 1.2
> **Niveau :** 2 (standard)
> **Auteur :** Tan Phi HUYNH
> **Date de création :** 2026-04-21
> **Dernière révision :** 2026-04-21 (post re-audit type-design v1.1 → v1.2)
> **@plan** `memory/project_deerflow_inspiration_plan.md` Phase 10.1 (extension TS miroir `wincorp-odin`, package wrapper SDK séparé de `wincorp-bragi` après audit archi HIGH-6)
> **Nom logique** : `@tanfeuille/hermod` (package npm, registry privé `npm.pkg.github.com`)
> **Package TS réel** : `wincorp-hermod` (Yggdrasil Tronc — Hermod, messager des dieux, chevauche Sleipnir)
> **Spec complémentaire TS** : `wincorp-bragi/specs/models-config.spec.md v1.1` (config pure, source unique)
> **Spec jumelle Python** : `wincorp-odin/specs/llm-factory.spec.md v1.3.2`

---

## 1. Objectif

Exposer aux consommateurs TypeScript (`wincorp-thor` + `wincorp-bifrost`) un **client Anthropic SDK pré-configuré et scopé à un modèle canonique** qui dérive automatiquement `model`, `timeout`, `maxRetries` et `baseURL` depuis la config canonique `@tanfeuille/bragi`. Remplace les 9 call sites (thor) + 5 routes (bifrost) où `new Anthropic()` coexiste avec des model IDs hardcodés et des timeouts inconsistants.

**Invariant central** : un `HermodClient` créé pour un `canonicalName` donné **ne peut pas appeler un autre modèle via `messages.create()`**. Le `model` n'est plus un argument que le consommateur passe à cette méthode — il est injecté par hermod depuis la config bragi. Garantit que les métriques `onUsage` ne mentent jamais (`canonical_name` collé à la réalité), que le pricing utilisé pour le coût est le bon, et que le timeout/retry appliqués correspondent au modèle réellement tapé.

**Exceptions assumées à l'invariant (documentées)** : les méthodes passthrough SDK `messages.stream()`, `messages.countTokens()`, `messages.batches.*`, `messages.parse()` **ne sont pas wrappées** par hermod. Elles conservent la signature SDK native, y compris l'argument `model` que le consommateur peut en théorie faire diverger. Le type `HermodClient` les expose intentionnellement (sinon le consumer devrait instancier un SDK nu, reproduisant la faille qu'hermod corrige), mais **sans injection automatique ni retry/métriques custom**. Justification scope v1.x : le wrap complet de ces méthodes est reporté (cf. §2 OUT + Q3, Q4, Q8).

**Pattern d'usage attendu** :

```ts
const sonnet = createClient("claude-sonnet");
const opus = createClient("claude-opus");

// Par appel, tu choisis explicitement quel client taper :
const extraction = await sonnet.messages.create({ max_tokens: 4096, messages: [...] });
const decision = await opus.messages.create({ max_tokens: 8192, messages: [...] });
```

**Séparation des rôles** :
- **Bragi** = **données pures**. Config statique, zéro dep LLM, zéro action réseau.
- **Hermod** = **actions**. Wrapper SDK avec injection model + retry custom + erreurs uniformes + métriques opt-in.

Hermod est volontairement **plus léger qu'odin Python** (cf. spec jumelle §2) : pas de circuit breaker distribué, pas de tracking tokens persistant Supabase, pas de hot-reload config. Ces responsabilités restent côté Python (pipelines batch heimdall) ou sont reportées v2+.

---

## 2. Périmètre

### IN — Ce que le module fait (v1.x)

- Exposer `createClient(canonicalName, options?)` qui retourne un `HermodClient` pré-configuré : type distinct de `Anthropic` nu (phantom brand + structural diff), instance SDK wrappée via Proxy.
- **Injecter automatiquement le `model`** dans `messages.create()` depuis `bragi.getModelId(canonicalName)`. Le consommateur ne passe plus `model:` (structurellement retiré du type).
- **Exposer en passthrough SDK** les autres méthodes `messages.*` (`stream`, `countTokens`, `batches`, `parse`) **sans** injection model ni retry custom — documenté comme exception à l'invariant §1.
- Dériver `timeout`, `maxRetries` SDK natif et `baseURL` par défaut depuis `bragi.getModelConfig(canonicalName)`.
- Ajouter un **layer de retry custom** au-delà du natif SDK sur `messages.create()` uniquement : détection timeout network (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`), parsing `Retry-After` sur 429, backoff exponentiel borné par `bragi.retry`.
- Exposer `options.perCallTimeoutMs` pour **override du timeout** au niveau d'un appel (cap max `bragi.timeout_sec * 1000`, warning si dépassement).
- Permettre l'override via `AbortSignal` (prime sur tout timeout).
- Émettre des events `UsageEvent` typés via callback `options.onUsage` après chaque `messages.create()` réussi (non-bloquant, `void | Promise<void>` supporté).
- Émettre des events `FailedAttemptEvent` via callback `options.onFailedAttempt` pour **chaque tentative échouée** (retry ou non), utile à la reconciliation coûts fantômes (tokens facturés côté serveur Anthropic même sur timeout client).
- Exposer le helper `calculateCost(usage, canonicalName): number` typé strict sur `Anthropic.Messages.Usage`.
- Exposer les **erreurs typées** : `HermodError` (abstraite) + `HermodConfigError` + `HermodTimeoutError` + `HermodRetryExhaustedError` + `HermodAbortedError` + `HermodUpstreamError` (wrap uniforme SDK 4xx/5xx non-hermod), avec `code` littéral.
- Exposer `HermodRetryExhaustedError.attemptsHistory` pour debug batch (chaque tentative : `attempt`, `elapsedMs`, `errorCode`, `errorMessage` tronqué+sanitize).
- Exposer les helpers `isHermodError(e): e is HermodError` (whitelist exhaustive des codes connus, anti pollution) et `isAnthropicSdkError(e): e is Anthropic.APIError` pour narrowing unifié.
- **Self-check runtime au premier `createClient`** : compare `BRAGI_VERSION` (runtime import) avec `HERMOD_BRAGI_VERSION` (embarqué au build). Divergence major → `HermodConfigError`. Divergence minor → warning stderr.
- Supporter l'override `ANTHROPIC_BASE_URL` + env debug (`HERMOD_DEBUG=1`, `HERMOD_DISABLE_RETRY=1`).
- Distribution ESM NodeNext uniquement, types `.d.ts` générés, compatibilité Node ≥20.
- Publier sur GitHub Packages sous `@tanfeuille/hermod`.

### OUT — Ce que le module ne fait PAS (v1.x, verrous architecturaux)

- **PAS de wrap retry/métriques/injection sur `messages.stream()`, `messages.countTokens()`, `messages.batches.*`, `messages.parse()`**. Ces méthodes sont exposées en passthrough SDK natif pour éviter que le consommateur doive instancier un SDK nu (fuite du drift canonicalName↔model qu'hermod est là pour prévenir). Mais elles ne bénéficient pas des garanties hermod (retry, `onUsage`, injection model). Le consommateur qui stream accepte la responsabilité de la cohérence modèle.
- **PAS de lecture directe du YAML** `wincorp-urd/referentiels/models.yaml`. Toute config passe par bragi (R1). Hermod ne connaît pas `js-yaml`.
- **PAS de persistance des métriques**. Les callbacks `onUsage` / `onFailedAttempt` sont les seules surfaces. Consommateur décide : log console, Supabase, Grafana, fichier, rien.
- **PAS de circuit breaker** mémoire ni distribué. Candidat v2 si un batch TS lourd le justifie. Entretemps, pipelines batch → odin Python.
- **PAS de tracking tokens cumulé**. Pas de compteur mémoire interne. Consommateur aggrège via callbacks.
- **PAS de prompt caching automatique**. Responsabilité consommateur via `cache_control` SDK.
- **PAS de multi-provider** (OpenAI, Mistral, DeepSeek). Structure non prête v1.x.
- **PAS de hot-reload config bragi**. Figée à la version installée. Upgrade = `npm install @tanfeuille/bragi@X.Y.Z`.
- **PAS de support CommonJS**. ESM-only. Test boot CJS vérifie erreur actionnable FR.
- **PAS de clé API hardcoded**. `ANTHROPIC_API_KEY` lu par SDK directement, hermod ne touche pas, ne logue pas.
- **PAS de retry sur erreurs d'authentification/autorisation** (401, 403). Fail fast → `HermodUpstreamError`.
- **PAS de retry sur erreurs de validation client** (4xx hors 408/429). Fail fast → `HermodUpstreamError`.
- **PAS de retry sur `ECONNREFUSED`** — signal fort de mauvaise config réseau, pas de transient. Fail fast (divergence avec `ECONNRESET`).
- **PAS de validation sémantique de la réponse** (`stop_reason`, contenu vide, refus safety). `onUsage` émis normalement, responsabilité consommateur.
- **PAS de garantie `client.messages instanceof Anthropic.Messages`**. Le Proxy wrapped ne reproduit pas la chaîne de prototypes SDK. Code tiers qui repose sur `instanceof` doit être adapté (test dédié).

---

## 3. Interface

### 3.1 Exports publics (`src/index.ts`)

```ts
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

// Types
export type {
  HermodClient,
  HermodClientOptions,
  HermodMessageCreateParams,
  FailedAttemptEvent,
  AttemptHistoryEntry,
  HermodLastRetryError,
} from "./types.js";

// Re-export shared types from bragi (note : bragi en peerDep, cf. §7)
export type { UsageEvent, CanonicalModelName } from "@tanfeuille/bragi";

// Constantes de traçabilité (injectées au build par sync-bragi)
export {
  HERMOD_VERSION,
  HERMOD_BRAGI_VERSION,
  HERMOD_BRAGI_URD_HASH,
  HERMOD_BRAGI_URD_DATE,
  HERMOD_SDK_VERSION,
  HERMOD_BUILD_AT,
} from "./metadata.generated.js";

// Constantes internes (PAS d'export public — référence pour isHermodError)
// const KNOWN_HERMOD_CODES = new Set([
//   "HERMOD_CONFIG_ERROR", "HERMOD_TIMEOUT", "HERMOD_RETRY_EXHAUSTED",
//   "HERMOD_ABORTED", "HERMOD_UPSTREAM",
// ] as const);
```

### 3.2 Signatures

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { CanonicalModelName, UsageEvent } from "@tanfeuille/bragi";

/**
 * Instancie un client SDK Anthropic scopé à un modèle canonique.
 * Le `model` est injecté automatiquement dans messages.create() depuis bragi.
 *
 * @param canonicalName Nom canonique bragi (ex "claude-sonnet"). Validé via bragi.
 * @param options Options optionnelles (callbacks, signal, override baseURL/apiKey, perCallTimeoutMs).
 * @returns HermodClient (type distinct d'Anthropic via phantom brand, messages.create sans param model).
 *
 * @throws HermodConfigError si bragi throw (wrap), OU si self-check version bragi échoue (R15b),
 *         OU si options.perCallTimeoutMs hors plage [1, timeout_sec * 1000].
 */
export function createClient(
  canonicalName: CanonicalModelName,
  options?: HermodClientOptions,
): HermodClient;

/**
 * Calcule le coût EUR d'un appel depuis `response.usage` et le pricing bragi.
 * Helper pur, pas d'effet de bord.
 *
 * @param usage Objet usage SDK typé `Anthropic.Messages.Usage`. Null/undefined autorisé (streaming).
 * @param canonicalName Nom canonique utilisé pour l'appel.
 * @returns Coût EUR, 6 décimales. `0` si usage null/undefined/incomplet.
 *
 * @throws HermodConfigError si bragi throw, OU si usage contient des valeurs négatives/overflow (R6c).
 */
export function calculateCost(
  usage: Anthropic.Messages.Usage | null | undefined,
  canonicalName: CanonicalModelName,
): number;

/**
 * Guard narrowing strict pour le consommateur.
 * Retourne true si :
 *   - e instanceof HermodError (cas nominal même realm)
 *   - OU e est un objet avec `code: string` ET `code` figure dans la whitelist KNOWN_HERMOD_CODES
 *     (cas cross-realm : deux versions de hermod via deps transitives)
 *
 * Whitelist exhaustive (anti pollution `{code:"HERMOD_FAKE"}` qui tomberait dans `default`) :
 *   "HERMOD_CONFIG_ERROR" | "HERMOD_TIMEOUT" | "HERMOD_RETRY_EXHAUSTED"
 *   | "HERMOD_ABORTED" | "HERMOD_UPSTREAM"
 *
 * Implémentation attendue (à tester au build) :
 *   const KNOWN_HERMOD_CODES = new Set<string>([...]);
 *   function isHermodError(e: unknown): e is HermodError {
 *     if (e instanceof HermodError) return true;
 *     if (e && typeof e === "object" && "code" in e && typeof (e as {code: unknown}).code === "string") {
 *       return KNOWN_HERMOD_CODES.has((e as {code: string}).code);
 *     }
 *     return false;
 *   }
 */
export function isHermodError(e: unknown): e is HermodError;

/**
 * `isAnthropicSdkError(e)` = true si `e instanceof Anthropic.APIError` OU structurellement reconnu
 * (`e.status: number` + `e.error.type: string`). Utile pour narrower les erreurs SDK non-wrapped
 * (edge case : erreur atypique non classée par hermod, ou erreur provenant d'un passthrough
 * streaming/batches/parse où hermod n'intervient pas).
 */
export function isAnthropicSdkError(e: unknown): e is Anthropic.APIError;
```

### 3.3 Types exportés

```ts
// === src/types.ts ===

/**
 * Phantom brand symbol — empêche qu'une instance SDK nue soit assignable à HermodClient.
 * Le brand vit sur l'objet `messages` (stamped par le Proxy au runtime).
 * Non exporté publiquement : le consommateur ne manipule jamais HermodClientBrand directement.
 */
declare const HermodClientBrand: unique symbol;

/**
 * Params de messages.create() sans `model` (injecté par hermod).
 * Le consommateur ne peut PAS passer `model:` — typage l'interdit.
 * Hérite de MessageCreateParamsNonStreaming — streaming non disponible via create, utiliser messages.stream().
 */
export type HermodMessageCreateParams = Omit<
  Anthropic.Messages.MessageCreateParamsNonStreaming,
  "model"
>;

/**
 * Client hermod. Distinct structurellement ET nominalement d'Anthropic.
 *
 * Distinction structurelle :
 *   - `messages.create` param : sans `model` (Omit) → contravariance empêche `new Anthropic()` d'être assigné
 *     (un SDK nu attend `model`, hermod n'en passe pas ; l'inverse ne tient pas non plus).
 *
 * Distinction nominale (phantom brand) :
 *   - `messages[HermodClientBrand]: true` — stamped par le Proxy au runtime.
 *   - Empêche aussi le cast `new Anthropic() as HermodClient` (le brand manque).
 *
 * Surface exposée sur `messages` :
 *   - `create` : wrappé (injection model + retry custom + callbacks).
 *   - `stream`, `countTokens`, `batches`, `parse` : **passthrough SDK direct**.
 *     Pas d'injection model, pas de retry hermod, pas de callbacks. Le consommateur qui
 *     les utilise assume la cohérence modèle (cf. §1 "exceptions assumées à l'invariant").
 *   - Autres propriétés SDK (`batches` top-level sur client, `beta`, etc.) : héritées via
 *     `Omit<Anthropic, "messages">`, passthrough direct.
 */
export interface HermodClient extends Omit<Anthropic, "messages"> {
  readonly messages: {
    /** Phantom brand stamped par le Proxy — empêche assignation depuis `new Anthropic().messages`. */
    readonly [HermodClientBrand]: true;

    /**
     * Crée un message. `model` injecté automatiquement depuis canonicalName.
     * Override `model` structurellement interdit (retiré du type Params).
     * `stream: true` structurellement interdit (NonStreaming). Utiliser `messages.stream()`.
     */
    create(
      params: HermodMessageCreateParams,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Messages.Message>;

    /** Streaming passthrough SDK sans retry/métriques hermod (cf. §1 exception assumée). */
    stream: Anthropic["messages"]["stream"];

    /** countTokens passthrough SDK sans retry/métriques. */
    countTokens: Anthropic["messages"]["countTokens"];

    /** batches API passthrough SDK sans injection/retry. Async haut volume — cf. Q4. */
    batches: Anthropic["messages"]["batches"];

    /** parse passthrough SDK sans injection. */
    parse: Anthropic["messages"]["parse"];
  };
}

export interface HermodClientOptions {
  /**
   * Callback invoqué après chaque messages.create() réussi (HTTP 2xx).
   * Non-bloquant : exception capturée et loggée en debug, jamais propagée.
   * Si le callback retourne une Promise, hermod attache `.catch(debugLog)` automatiquement (R5a).
   * Jamais invoqué sur messages.stream/countTokens/batches/parse (passthrough SDK).
   */
  readonly onUsage?: ((event: UsageEvent) => void | Promise<void>) | undefined;

  /**
   * Callback invoqué pour CHAQUE tentative échouée sur messages.create() (transiente ou finale).
   * Utile à la reconciliation coûts fantômes (tokens facturés côté serveur sur timeout client).
   * Non-bloquant, même contrat que onUsage.
   */
  readonly onFailedAttempt?: ((event: FailedAttemptEvent) => void | Promise<void>) | undefined;

  /**
   * AbortSignal propagé au SDK. Abort prime sur tout timeout/retry.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * Override baseURL SDK. Prime sur ANTHROPIC_BASE_URL env var.
   */
  readonly baseURL?: string | undefined;

  /**
   * Override API key (fortement déconseillé en prod).
   */
  readonly apiKey?: string | undefined;

  /**
   * Override timeout pour cet appel. Cap = bragi.timeout_sec * 1000.
   * Si > cap, warning debug + valeur tronquée au cap.
   * Si < 1 ou non-number, HermodConfigError au createClient.
   */
  readonly perCallTimeoutMs?: number | undefined;
}

/**
 * Union discriminée des erreurs possibles comme lastError d'un retry épuisé.
 * Jamais `unknown` — le consommateur peut narrower sans gymnastique.
 * HermodUpstreamError ici = 5xx retry-épuisé (pas 4xx fail-fast, qui throw direct sans wrap).
 */
export type HermodLastRetryError =
  | HermodTimeoutError
  | HermodUpstreamError
  | HermodNetworkError;

/**
 * Erreur network wrapped pour discrimination union (Node errno codes).
 * ECONNREFUSED absent : fail-fast, ne passe jamais par retry, donc jamais dans lastError.
 */
export interface HermodNetworkError {
  readonly code: "HERMOD_NETWORK_ERROR";
  readonly errno: "ECONNRESET" | "ETIMEDOUT" | "ENOTFOUND" | "EPIPE";
  readonly cause: Error;
}

/**
 * Event émis pour chaque tentative échouée (retry ou fail final) sur messages.create().
 *
 * Mapping `reason` (exhaustif, anti-"other" silencieux) :
 *   - "timeout"            : APITimeoutError SDK ou HermodTimeoutError (timeout client)
 *   - "network"            : errno ∈ {ECONNRESET, ETIMEDOUT, ENOTFOUND, EPIPE} (transient)
 *   - "connection_refused" : errno = ECONNREFUSED (fail-fast, apparaît 1 seule fois sur attempt=1)
 *   - "429"                : HTTP 429 Too Many Requests
 *   - "5xx"                : HTTP 500, 502, 503, 504 et autres 5xx
 *   - "abort"              : AbortSignal reçu (apparaît 1 seule fois avant HermodAbortedError)
 *   - "other"              : exception non classée (bug code, primitive throw wrappée)
 */
export interface FailedAttemptEvent {
  readonly call_id: string;                          // UUID v4 partagé avec UsageEvent si succès final
  readonly canonical_name: CanonicalModelName;
  readonly attempt: number;                          // 1-indexed
  readonly elapsed_ms: number;                       // depuis début de CETTE tentative
  readonly reason:
    | "timeout"
    | "network"
    | "connection_refused"
    | "429"
    | "5xx"
    | "abort"
    | "other";
  readonly error_code: string;                       // ex "504", "ECONNRESET", "APITimeoutError"
  readonly http_status: number | undefined;          // si HTTP erreur
  readonly retry_after_ms: number | undefined;       // si 429 avec Retry-After parsé
  readonly will_retry: boolean;                      // true si tentative suivante prévue
  readonly timestamp_iso: string;
}

/**
 * Entrée de l'historique des tentatives, attachée à HermodRetryExhaustedError.
 */
export interface AttemptHistoryEntry {
  readonly attempt: number;
  readonly elapsed_ms: number;
  readonly error_code: string;
  readonly error_message: string;                    // tronqué 200 chars + API key redacted
  readonly http_status: number | undefined;
}
```

### 3.4 Erreurs

Hiérarchie stable v1.2 : 5 classes concrètes, `code` littéral, `HermodRetryExhaustedError.lastError` union typée (pas `unknown`), `attemptsHistory` pour debug batch.

**Frontière `HermodUpstreamError` vs `HermodRetryExhaustedError`** :
- **4xx fail-fast** (401, 403, 400, 404, 413, 422, 501, autres 4xx) → throw direct `HermodUpstreamError`. Jamais wrappé dans `HermodRetryExhaustedError`.
- **5xx retry-épuisé** (500, 502, 503, 504, autres 5xx retryables qui échouent N fois) → throw `HermodRetryExhaustedError` avec `lastError: HermodUpstreamError(httpStatus=5xx)`.
- **Timeout retry-épuisé** → `HermodRetryExhaustedError` avec `lastError: HermodTimeoutError`.
- **Network transient retry-épuisé** → `HermodRetryExhaustedError` avec `lastError: HermodNetworkError`.
- **Retry désactivé** (`retry: null`, `HERMOD_DISABLE_RETRY=1`, `max_attempts=1`) + échec unique → throw direct l'erreur finale typée (cf. R3p), jamais wrap `HermodRetryExhaustedError`.

```ts
export abstract class HermodError extends Error {
  abstract readonly code:
    | "HERMOD_CONFIG_ERROR"
    | "HERMOD_TIMEOUT"
    | "HERMOD_RETRY_EXHAUSTED"
    | "HERMOD_ABORTED"
    | "HERMOD_UPSTREAM";

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Note: Object.setPrototypeOf supprimé. Target ES2022 garantit la chaîne correcte via super().
    // Si downleveling vers ES5 requis par un consommateur, ajouter via build custom.
  }
}

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

export class HermodTimeoutError extends HermodError {
  readonly code = "HERMOD_TIMEOUT" as const;
  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly canonicalId: string,
    readonly timeoutMs: number,
    readonly elapsedMs: number,
    readonly attempt: number,
  ) {
    super(`Timeout ${timeoutMs}ms dépassé (${elapsedMs}ms écoulés) — modèle ${canonicalName} (${canonicalId}), tentative ${attempt}`);
  }
}

export class HermodRetryExhaustedError extends HermodError {
  readonly code = "HERMOD_RETRY_EXHAUSTED" as const;
  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly attempts: number,                       // toujours >= 2 (cf. R3p)
    readonly lastError: HermodLastRetryError,        // typé union, pas unknown
    readonly totalElapsedMs: number,
    readonly attemptsHistory: ReadonlyArray<AttemptHistoryEntry>,
  ) {
    super(
      `Retry épuisé après ${attempts} tentatives sur modèle ${canonicalName} — dernière erreur : ${lastError.code} (${summarizeLast(lastError)})`,
    );
  }
}

export class HermodAbortedError extends HermodError {
  readonly code = "HERMOD_ABORTED" as const;
  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly reason?: string | undefined,
  ) {
    super(`Abort externe reçu — modèle ${canonicalName}${reason ? ` (raison: ${reason})` : ""}`);
  }
}

/**
 * Wrap uniforme des erreurs SDK Anthropic qui sortent d'hermod :
 *   - 4xx fail-fast (401, 403, 400, 404, 413, 422, 501, autres 4xx) → direct.
 *   - 5xx final après retry épuisé → imbriqué dans HermodRetryExhaustedError.lastError.
 * Permet au consommateur d'avoir un narrowing uniforme `error.code === "HERMOD_..."`.
 */
export class HermodUpstreamError extends HermodError {
  readonly code = "HERMOD_UPSTREAM" as const;
  constructor(
    readonly canonicalName: CanonicalModelName,
    readonly httpStatus: number,
    readonly upstreamCode: string,                   // ex "authentication_error", "invalid_request_error"
    readonly upstreamMessage: string,                // sanitize clé API (R10) — contrat runtime
    readonly cause?: unknown | undefined,
  ) {
    super(`Erreur upstream Anthropic ${httpStatus} (${upstreamCode}) sur modèle ${canonicalName} — ${upstreamMessage}`);
  }
}
```

| Code | Condition | Action consommateur |
|------|-----------|---------------------|
| `HERMOD_CONFIG_ERROR` | Bragi throw (unknown/disabled/corrupted), OU options invalides (`perCallTimeoutMs` hors plage), OU version bragi drift major, OU usage anomalies R6c | Corriger config/versions |
| `HERMOD_TIMEOUT` | `timeout_sec` ou `perCallTimeoutMs` dépassé sur 1 tentative ET pas de retry prévu (retry=null, disable_retry, max_attempts=1) | Dégradation UX, log + escalade |
| `HERMOD_RETRY_EXHAUSTED` | ≥2 tentatives ont échoué. `attempts` toujours ≥ 2. `lastError: HermodTimeoutError \| HermodUpstreamError(5xx) \| HermodNetworkError`. `attemptsHistory` pour debug | Investigate via `attemptsHistory`, dégradation UX |
| `HERMOD_ABORTED` | `AbortSignal` abort() reçu | UX cancel, propagation consommateur |
| `HERMOD_UPSTREAM` | SDK erreur fail-fast (401, 403, 400, 404, 413, 422, 501, autres 4xx) — non retryable, pas de wrap RetryExhausted | Check infra (auth, quota, prompt, model retiré) |

---

## 4. Règles métier

### 4.1 Composition avec bragi

- **R1: Bragi source unique de config**. Tout paramètre (`model`, `timeout`, `maxRetries`, `baseURL` défaut, `pricing`) provient de `bragi.getModelId()` / `bragi.getModelConfig()` / `bragi.getPricing()`. Aucun chemin hermod ne lit `models.yaml`, JSON local, env var modèle-spécifique ou valeur hardcodée. Test unitaire dédié.

- **R1a: Version bragi figée au install**. Upgrade config = `npm install @tanfeuille/bragi@X.Y.Z`. Pas de re-fetch runtime.

- **R2: Propagation stricte des erreurs bragi**. Si `bragi.get*()` throw, hermod **wrap** en `HermodConfigError` avec `cause: originalError` + `canonicalName`. Pas de fallback silencieux.

- **R2a: Cross-realm via `code` littéral + whitelist**. Le `cause` conserve l'accès `cause.code === "BRAGI_..."`. Helper `isHermodError` vérifie d'abord `instanceof HermodError`, puis fallback sur whitelist `KNOWN_HERMOD_CODES` stricte (pas `.startsWith("HERMOD_")` permissif — empêche pollution `{code:"HERMOD_FAKE"}`). Pattern consumer :
  ```ts
  catch (e) {
    if (isHermodError(e) && e.code === "HERMOD_CONFIG_ERROR" && e.cause?.code === "BRAGI_MODEL_DISABLED") { ... }
  }
  ```

- **R2b: Pas de re-validation hermod**. Délègue à bragi (`isCanonicalModelName`). Hermod n'ajoute pas de surface concurrente.

- **R2c: Bump bragi major → bump hermod minor obligatoire**. Doc R15 + gate CI R15a.

- **R2d: Injection automatique du `model` via Proxy**. Au `createClient`, hermod :
  1. Appelle `bragi.getModelConfig(canonicalName)` → récupère config complète.
  2. Instancie `new Anthropic({ timeout, maxRetries: 0, baseURL })` (retry SDK natif désactivé, hermod gère via R3).
  3. Retourne un **Proxy** de cette instance qui intercepte `get(prop)` :
     - Si `prop === "messages"` → retourne un objet wrappé avec :
       - `[HermodClientBrand]: true` (stamp runtime du phantom brand).
       - `create(params)` qui préfixe `{ model: bragi.getModelId(canonicalName), ...params }` et délègue.
       - `stream`, `countTokens`, `batches`, `parse` : passthrough direct de l'instance SDK (pas d'interception, pas d'injection).
     - Toute autre propriété → `Reflect.get(target, prop, receiver)` (passthrough `beta`, autres top-level).
  4. Typage exposé : `HermodClient` avec `Omit<Anthropic, "messages">` + `messages` brandé. Impossible côté TS de passer `model:` à `create()`, impossible d'assigner `new Anthropic()` à `HermodClient` (brand manquant).

### 4.2 Retry strategy (sur `messages.create()` uniquement)

- **R3: Retry exponentiel borné selon bragi**. Au-delà du retry SDK natif (désactivé par hermod, `maxRetries: 0` R2d), hermod implémente le retry custom **uniquement sur `messages.create()`**. Les méthodes passthrough (`stream`, `countTokens`, `batches`, `parse`) n'ont pas de retry hermod. Couvre :
  - Timeout network (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`).
  - `HermodTimeoutError` (conversion de `APITimeoutError` SDK).
  - 5xx retryables (500, 502, 503, 504, autres 5xx).
  - 408 Request Timeout.
  - 429 Too Many Requests avec parsing `Retry-After`.

- **R3a: Paramètres depuis bragi**. `getModelConfig(name).retry` donne `{ base_delay_sec, cap_delay_sec, max_attempts }`. Conversion ms stricte.
  - `delay(attempt) = min(base_delay * 2^(attempt-1), cap_delay)`.
  - `max_attempts` inclut le 1er essai (`max_attempts=3` → 1 essai + 2 retries).

- **R3b: `Retry-After` 429 primé sur backoff**. Parse robuste (nombre en secondes, HTTP-date RFC 7231 avec marge +500ms pour clock skew). Attend `max(retry_after_ms, backoff_calculé)`. Cap `cap_delay_sec` ignoré si `Retry-After > cap` (respect instruction serveur). Si delta HTTP-date > 60min, fail fast avec `HermodRetryExhaustedError`.

- **R3c: Pas de retry si `retry: null`**. `max_attempts` implicite = 1. Fail fast sur 1ère erreur directement en `HermodTimeoutError` ou `HermodUpstreamError` (pas wrap `HermodRetryExhaustedError`, cf R3p).

- **R3d: Matrice stricte retry / fail fast**.

  | Condition | Retry | Classification finale si retry épuisé |
  |---|---|---|
  | 200-299 (succès) | N/A | — |
  | 408 Request Timeout | OUI | `HermodRetryExhaustedError(lastError: HermodUpstreamError(408))` |
  | 429 Too Many Requests | OUI (respect Retry-After) | `HermodRetryExhaustedError(lastError: HermodUpstreamError(429))` |
  | 500, 502, 503, 504 | OUI | `HermodRetryExhaustedError(lastError: HermodUpstreamError(5xx))` |
  | Autres 5xx (505+) | OUI | Idem |
  | Node `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE` | OUI | `HermodRetryExhaustedError(lastError: HermodNetworkError)` |
  | Node `ECONNREFUSED` | **NON** (fail fast) | `HermodConfigError("Connection refused — vérifier ANTHROPIC_BASE_URL")` direct |
  | `AbortError` (signal abort) | NON | `HermodAbortedError` direct |
  | 400 Bad Request | NON | `HermodUpstreamError(400)` direct |
  | 401 Unauthorized | NON | `HermodUpstreamError(401)` direct |
  | 403 Forbidden | NON | `HermodUpstreamError(403)` direct |
  | 404 Not Found | NON | `HermodUpstreamError(404)` direct |
  | 413, 414, 422 | NON | `HermodUpstreamError(4xx)` direct |
  | 501 Not Implemented | NON | `HermodUpstreamError(501)` direct |
  | Autres 4xx | NON | `HermodUpstreamError(4xx)` direct |
  | `TypeError`, `ReferenceError` JS | NON | Erreur brute propagée (bug code consumer) |
  | Exception primitive (`throw "x"`, `throw 42`) | NON | Wrap `Error(String(e))` fail fast |

- **R3e: Budget timeout par tentative, pas cumulé**. Chaque tentative = budget `perCallTimeoutMs ?? timeout_sec * 1000`. Retry ne réduit pas le budget de la tentative suivante. Worst-case total = `max_attempts * timeout + sum(backoffs + retry_afters)`. Consumer sensible latence = `AbortController` externe.

- **R3f: Abort prime sur retry**. `signal.aborted` à n'importe quel moment → `HermodAbortedError` immédiat, pas de tentative supplémentaire.

- **R3g: Pas de retry sur `HermodConfigError`**. Fail fast (erreur config permanente).

- **R3h: Override `HERMOD_DISABLE_RETRY=1`**. Env var opt-in, force `max_attempts=1` sur tous les clients du process. Log stderr à chaque `createClient` concerné (pas seulement au boot).

- **R3i: Isolation des compteurs retry par appel**. Le compteur `attempt`, le timer backoff, `lastError` sont scoped à l'invocation `messages.create()` (closure locale), jamais au module ni à l'instance `HermodClient`. Garantit la correction sur N appels simultanés via le même client. Test dédié : 10 appels parallèles avec 2 failures + 1 succès, vérifie `attempts=3` sur chaque (pas `attempts=30` partagé).

- **R3j: Passthrough streaming SDK — pas de retry hermod**. `messages.stream()` est exposé en passthrough direct de l'instance SDK (cf R2d). Aucun wrap retry/métriques/injection hermod. Un stream interrompu par `ECONNRESET` propage l'erreur SDK brute au consommateur — responsabilité consumer (cf. §2 OUT). Justification : un retry sur stream = re-jeu du prompt = double facturation + response divergente.

  **Note de suppression v1.2** : la règle R3k v1.1 sur "détection `stream: true` dans params de create()" est supprimée — le type `HermodMessageCreateParams = Omit<...NonStreaming, "model">` exclut structurellement `stream: true` (TS2322 à la compilation). Pas besoin de garde-fou runtime.

- **R3l: Classification défensive des exceptions**. Avant classification retry, wrap toute exception non-Error en `new Error(String(e))`. Exception primitive = fail fast (pas retry).

- **R3m: `ECONNREFUSED` fail fast**. Divergence avec `ECONNRESET` / `ETIMEDOUT` : refused connection signale serveur absent (mock down, mauvaise URL, firewall). Pas un transient. Retry inutile. Throw `HermodConfigError` direct avec message actionnable "Connection refused — vérifier ANTHROPIC_BASE_URL". **Émet quand même un `FailedAttemptEvent` avec `reason: "connection_refused"`** avant throw (pour que le consumer puisse tracer).

- **R3n: Validation `max_attempts >= 1`**. Hermod check au `createClient` que `bragi.getModelConfig(name).retry?.max_attempts >= 1` si retry non-null. Sinon → `HermodConfigError`. Check défensif, bragi doit idéalement enforce en amont (candidat remontée spec bragi v1.2).

- **R3o: Circuit breaker reporté**. Pas de protection contre retry storm sur outage Anthropic global (503 persistant cross-appels). Consumer batch > 10 appels/minute doit implémenter son propre circuit breaker OU utiliser odin Python. Doc warning §7.

- **R3p: `HermodRetryExhaustedError` garanti `attempts >= 2`**. Si 1 seule tentative puis échec (retry=null, HERMOD_DISABLE_RETRY, max_attempts=1), hermod throw directement l'erreur finale typée (`HermodTimeoutError`, `HermodUpstreamError`, `HermodNetworkError` wrappé, ou `HermodConfigError` pour ECONNREFUSED). Pas de wrap `HermodRetryExhaustedError` sur attempt=1. Invariant consommateur : `HermodRetryExhaustedError` ⇒ au moins 2 échecs.

### 4.3 Timeout

- **R4: Timeout SDK = `perCallTimeoutMs ?? timeout_sec * 1000`**. Injecté dans options SDK `timeout`. SDK natif throw `APITimeoutError` → hermod re-emballe en `HermodTimeoutError(canonicalName, canonicalId, timeoutMs, elapsedMs, attempt)`.

- **R4a: Override `perCallTimeoutMs`**. Option `HermodClientOptions.perCallTimeoutMs`. Comportement :
  1. Si absent → `bragi.timeout_sec * 1000`.
  2. Si < 1 ou non-number → `HermodConfigError` au `createClient`.
  3. Si > `bragi.timeout_sec * 1000` → **tronqué** au cap bragi + warning debug `[hermod] perCallTimeoutMs=X tronqué au cap bragi timeout_sec=Y`.
  4. Utilisation typique : Vercel function timeout 300s, user passe `perCallTimeoutMs: 60_000` pour Opus (timeout bragi 180s) → budget UI 1min avant fail-fast.

- **R4b: Abort externe prime sur timeout**. Priorité : `signal.aborted` > `timeout` > réussite SDK.

- **R4c: Timeout bragi plage validée**. Hermod check au `createClient` : `1 <= timeout_sec <= 600` (plage sane). Hors plage → `HermodConfigError`. Candidat remontée bragi v1.2 pour enforce en amont.

- **R4d: `duration_ms` monotonic**. Utilise `performance.now()` (monotonic, Node ≥20) pour calcul durée. Jamais `Date.now()` sur du delta (risque clock rewind NTP). `timestamp_iso` reste `new Date().toISOString()` (wall clock, log humain).

### 4.4 Métriques & coût

- **R5: `onUsage` invoqué après chaque `messages.create()` réussi**. Déclenché post HTTP 2xx. **Jamais invoqué sur passthrough streaming/countTokens/batches/parse**. Event :
  - `call_id: string` (UUID v4 généré à chaque `messages.create`, partagé avec `onFailedAttempt` si retries précédents)
  - `canonical_name: CanonicalModelName`
  - `canonical_id: CanonicalModelId`
  - `input_tokens: number`
  - `output_tokens: number`
  - `cost_eur: number` (via `calculateCost`)
  - `duration_ms: number` (monotonic depuis début 1ère tentative, inclut backoff)
  - `timestamp_iso: string` (fin d'appel wall clock)

- **R5a: Callback non-bloquant, support sync + async**. Signature `(event) => void | Promise<void>`. Mécanisme :
  ```ts
  queueMicrotask(() => {
    try {
      const result = onUsage(event);
      if (result && typeof result.then === "function") {
        result.catch((e) => debugLog("[hermod] onUsage async rejection:", sanitize(e)));
      }
    } catch (e) {
      debugLog("[hermod] onUsage sync throw:", sanitize(e));
    }
  });
  ```
  - Sync throw → catch.
  - Async reject → `.catch()` explicite attaché (PAS de unhandled rejection globale).
  - Debug log uniquement si `HERMOD_DEBUG=1` ; en prod, silencieux.

- **R5b: `onFailedAttempt` invoqué pour CHAQUE tentative échouée sur `messages.create()`**. Transient (will_retry=true) ou final (will_retry=false). Utile à la reconciliation coûts fantômes. Même mécanisme non-bloquant que R5a. **Mapping `reason` exhaustif** :

  | Classification R3d | `reason` émis | `http_status` | `will_retry` |
  |---|---|---|---|
  | `APITimeoutError` / `HermodTimeoutError` | `"timeout"` | undefined | true si attempts restants |
  | errno ∈ {ECONNRESET, ETIMEDOUT, ENOTFOUND, EPIPE} | `"network"` | undefined | true si attempts restants |
  | errno ECONNREFUSED (fail-fast) | `"connection_refused"` | undefined | **false** (jamais retry) |
  | HTTP 429 | `"429"` | 429 | true si attempts restants |
  | HTTP 408, 500, 502, 503, 504, autres 5xx | `"5xx"` (408 inclus ici par simplification) | status HTTP | true si attempts restants |
  | AbortSignal | `"abort"` | undefined | **false** |
  | 4xx fail-fast (400, 401, 403, 404, 413, 422, 501, autres) | pas de `FailedAttemptEvent` émis — `HermodUpstreamError` direct sans passer par retry loop | — | — |
  | Exception primitive / `TypeError` | `"other"` | undefined | false |

- **R5c: `onUsage` NON invoqué sur échec final**. Si `HermodRetryExhaustedError` ou autre erreur terminale, pas d'`onUsage`. Toutes les tentatives échouées sont tracées via `onFailedAttempt`. Consumer aggregate via `call_id`.

- **R5d: `onUsage` / `onFailedAttempt` NON invoqués sur passthrough**. `messages.stream()`, `messages.countTokens()`, `messages.batches.*`, `messages.parse()` = zéro callback hermod. Consumer qui stream et veut les métriques = calcul manuel via `calculateCost` post-stream.

- **R5e: `stop_reason` passthrough**. Hermod ne valide pas `response.stop_reason` (`max_tokens`, `refusal`, `tool_use`, `end_turn`). `onUsage` émet normalement, consommateur check `response.stop_reason` lui-même. Pas dans `UsageEvent` v1.x (candidat Q2 future).

- **R5f: `timestamp_iso` capturé avant `queueMicrotask`**. Instant de fin d'appel réseau, pas de la microtask d'émission. Garantit ordre chronologique cross-calls même si ordre d'invocation `onUsage` différent (microtask queue).

- **R6: `calculateCost(usage, name)` pur**. Formule :
  ```ts
  const p = bragi.getPricing(name);
  const input_m = (usage?.input_tokens ?? 0) / 1_000_000;
  const output_m = (usage?.output_tokens ?? 0) / 1_000_000;
  return round6(input_m * p.input_per_million_eur + output_m * p.output_per_million_eur);
  ```
  Usage null/undefined → `0`. Pas throw.

- **R6a: Pas d'arrondi prématuré par token**. Round uniquement sur résultat final.

- **R6b: Pure function**. Pas d'I/O, pas de mutation.

- **R6c: Guard valeurs anormales**. Si `input_tokens` ou `output_tokens` :
  - `< 0` → `HermodConfigError("Usage négatif : corruption SDK")`.
  - `> 10_000_000` (10M tokens, plafond raisonnable 5× max context Opus) → `HermodConfigError("Usage anormal : vérifier SDK")`.
  - `NaN`, `Infinity` → `HermodConfigError`.
  Cartésien testé : `[neg, pos]`, `[pos, neg]`, `[neg, neg]`, `[overflow, ok]`, `[NaN, ok]`.

### 4.5 Configuration & environnement

- **R7: Env vars reconnues**.

  | Var | Effet | Log |
  |---|---|---|
  | `ANTHROPIC_API_KEY` | Lue par SDK (hermod ne touche pas) | Non |
  | `ANTHROPIC_BASE_URL` | Override baseURL passthrough SDK | Hostname seulement, `HERMOD_DEBUG=1` |
  | `HERMOD_DISABLE_RETRY` | Force `max_attempts=1` | Systématique stderr à chaque `createClient` (R3h) |
  | `HERMOD_DEBUG` | Active logs verbeux | Systématique au boot |

- **R7a: Priorité baseURL**. `options.baseURL` > `ANTHROPIC_BASE_URL` env > SDK défaut.

- **R7b: API key jamais loggée**. Regex redaction `/sk-[A-Za-z0-9_-]+/g` → `sk-***<last4>` ou `<redacted>`. Test dédié vérifie absence dans `HermodError.message` + `.stack` + logs debug.

- **R7c: BaseURL loggée partiellement**. Hostname uniquement, pas path/query.

- **R7d: Test pollution `HERMOD_DISABLE_RETRY` cross-tests**. Documenté : tests doivent utiliser `vi.stubEnv` (auto-cleanup) ou restaurer dans `afterEach`. Log stderr systématique R3h aide la détection de fuite.

- **R8: Pas de config file hermod**. Pas de `.hermodrc`. Config via bragi + env vars + options inline.

### 4.6 Sécurité & verrous

- **R9: Messages d'erreur en FR**. Stack trace EN. Sanitize anti log-injection (troncation 64 chars + `JSON.stringify` sur valeurs brutes suspectes).

- **R10: API key jamais dans erreurs**. Redaction regex R7b appliquée sur tout message/stack avant inclusion. Test `HermodError` avec fixture `Bearer sk-ant-test-FAKE` vérifie redaction.

- **R11: Aucun side-effect I/O au load**. Test `test_no_runtime_side_effects.test.ts` : import package dans Node instrumenté (fs stubs) vérifie zéro `fs.*`, `net.connect`, `fetch(` au load.

- **R11a: Aucune dep cachée runtime**. `dependencies` runtime = exactement `@anthropic-ai/sdk` (SDK utilise undici transitive). `@tanfeuille/bragi` en **`peerDependencies`** (R11c). Interdits : `axios`, `node-fetch` direct, `langchain`, autres SDK LLM, `js-yaml`, `@supabase/supabase-js`.

- **R11b: Aucun side-effect au load (pas de fetch initial, pas de check réseau)**.

- **R11c: Bragi en `peerDependencies` pas `dependencies`**. Décision adversariale (anti H-8 audit type-design) : évite fragmentation de type cross-version (2 versions bragi transitives → 2 `UsageEvent` structurellement séparés). Friction install +1 commande consumer (`npm install @tanfeuille/hermod @tanfeuille/bragi`) acceptée pour infra critique. `package.json` :
  ```json
  {
    "peerDependencies": { "@tanfeuille/bragi": "^0.1.0" },
    "peerDependenciesMeta": { "@tanfeuille/bragi": { "optional": false } },
    "devDependencies": { "@tanfeuille/bragi": "^0.1.0" }
  }
  ```
  Documenté dans README install section.

- **R11d: Phantom brand stamped au runtime**. Le Proxy R2d ajoute `[HermodClientBrand]: true` sur l'objet `messages` retourné. Empêche qu'un consumer cast `new Anthropic() as HermodClient` sans passer par `createClient` — le brand manquera au runtime (et le typage TS le bloque déjà à la compilation). Test dédié vérifie la présence du brand.

- **R12: Types TS strict**. `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitReturns: true`, `noFallthroughCasesInSwitch: true`.

### 4.7 Build & distribution

- **R13: ESM-only**. `"type": "module"`, pas de build dual CJS.

- **R13a: Test boot CJS explicite**. `require('@tanfeuille/hermod')` depuis CJS → `ERR_REQUIRE_ESM` avec message FR actionnable. Aligné `feedback_tsx_esm_cjs_boot_crash.md`.

- **R14: `sideEffects: false`**. Pas de code global au load, tree-shakeable. Test CI bundle treeshake agressif vérifie `createClient` + `calculateCost` survivent séparément.

- **R15: Version sync bragi documentée**. `peerDependencies."@tanfeuille/bragi"` = `"^0.1.0"`. Bump obligatoire quand bragi major (`0.x → 1.0`) ou minor breaking. `HERMOD_BRAGI_VERSION` embarqué au build.

- **R15a: Gate CI `check-sync-bragi`**. Workflow `publish.yml` vérifie `BRAGI_VERSION` (import peerDep devDep) === `HERMOD_BRAGI_VERSION` embarqué. Divergence → fail publish.

- **R15b: Self-check runtime au premier `createClient`**. Hermod compare `BRAGI_VERSION` (import runtime) avec `HERMOD_BRAGI_VERSION` (embarqué). Règle :
  - Match exact → OK.
  - Divergence patch (`0.1.0` vs `0.1.1`) → log debug warning.
  - Divergence minor ou major → `HermodConfigError` au `createClient` avec message : "hermod@X lié à bragi@Y au build, runtime résout bragi@Z. Aligne les versions : `npm install @tanfeuille/bragi@Y` ou `npm install @tanfeuille/hermod@latest`."
  - Check idempotent (memoized après 1er appel par process).

- **R16: Script `scripts/sync-bragi.mjs`**. Tool dev/CI :
  1. Lit `node_modules/@tanfeuille/bragi/package.json` → version.
  2. Lit `node_modules/@tanfeuille/bragi/dist/models.generated.js` → `BRAGI_URD_HASH`, `BRAGI_URD_DATE`.
  3. Écrit `src/metadata.generated.ts` avec toutes les constantes HERMOD_*.
  4. Exécuté en `prepare` npm hook + CI pre-build.

- **R17: Publication GitHub Packages**. Registry `https://npm.pkg.github.com`. CI déclenché sur tag `v*`. Gate : `test` + `lint` + `build` + `check-sync-bragi` + `publish`.

- **R18: Coordination version consommateurs**. Boot log :
  ```
  [hermod] consumer=<name>, hermod=<semver>, bragi=<semver>, sdk=<semver>, urd_hash=<sha8>, urd_date=<iso>
  ```
  Script ops `check-consumers-sync.mjs` aligné bragi R22.

---

## 5. Edge cases

### 5.1 Input boundary (`createClient` / `calculateCost`)

- **EC1**: `createClient(x as any)` avec x non-CanonicalModelName → bragi throw `ModelNotFoundError`, hermod wrap `HermodConfigError` avec `cause` + `canonicalName: String(x).slice(0, 64)` sanitize.
- **EC2**: `createClient("claude-opus")` modèle disabled → bragi throw `ModelDisabledError`, hermod wrap. Pas de fallback silencieux.
- **EC3**: `createClient(null as any)` → bragi throw via guard, hermod wrap.
- **EC4**: Bragi config corrompue (`BRAGI_INVALID_CONFIG`) → hermod wrap.
- **EC5**: `options.signal.aborted === true` à `createClient` → warning debug (`[hermod] signal déjà aborté à createClient`) + instance SDK créée quand même. Le premier `messages.create()` throw `HermodAbortedError` immédiat.
- **EC6**: `calculateCost(null, name)` → retourne `0`. Pas throw.
- **EC7**: `calculateCost({}, name)` → retourne `0` (tokens undefined).
- **EC8**: `calculateCost({ input_tokens: -5 }, name)` OU `{ input_tokens: 100, output_tokens: -5 }` OU toute combinaison négative → `HermodConfigError` (R6c). Cartésien testé.
- **EC9**: `calculateCost({ input_tokens: NaN }, name)` OU `Infinity` OU `> 10_000_000` → `HermodConfigError` (R6c).
- **EC9b**: `createClient("claude-sonnet", { perCallTimeoutMs: -1 })` OU `0` OU non-number → `HermodConfigError` (R4a).
- **EC9c**: `createClient("claude-sonnet", { perCallTimeoutMs: 9_999_999 })` (> cap) → tronqué au cap + warning debug, pas throw.

### 5.2 Retry behavior

- **EC10**: 429 sans `Retry-After` → backoff exponentiel standard. `FailedAttemptEvent(reason="429")`.
- **EC11**: 429 avec `Retry-After: 10` (secondes) → attendre `max(10s, backoff)`. `FailedAttemptEvent(reason="429", retry_after_ms=10000)`.
- **EC12**: 429 avec `Retry-After: <HTTP-date>` → parse RFC 7231, delta + marge +500ms (clock skew R3b). Delta négatif ou < 1s → attendre 1s. Delta > 60min → fail fast `HermodRetryExhaustedError`.
- **EC13**: 503 puis 200 → 1 retry, succès, `onUsage` invoqué, `onFailedAttempt(reason="5xx")` émis pour la 1ère tentative.
- **EC14**: SDK `APITimeoutError` → hermod convertit **systématiquement** en `HermodTimeoutError`. Si non-final → retry, `onFailedAttempt(reason="timeout")` émis. Si final avec retry → `HermodRetryExhaustedError.lastError: HermodTimeoutError`. Si final sans retry (retry=null, disable_retry, max_attempts=1) → throw directement `HermodTimeoutError` (R3p).
- **EC15**: `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `EPIPE` mid-request → retry. `FailedAttemptEvent(reason="network", error_code=errno)`.
- **EC16**: Abort pendant backoff → `HermodAbortedError` immédiat. `FailedAttemptEvent(reason="abort", will_retry=false)` émis avant throw.
- **EC17**: Abort pendant tentative → détecté via `error.name === "AbortError"` OU `error.code === "ABORT_ERR"` (Node 20+) OU `signal.aborted === true` au catch. Convertit en `HermodAbortedError` avec `reason = signal.reason ?? "Abort via options.signal"`. Pattern robuste cross-realm (pas `instanceof`).
- **EC18**: `retry: null` dans bragi + erreur 500 → 0 retry, throw **directement** `HermodUpstreamError` (pas wrap `HermodRetryExhaustedError`, cf R3p).
- **EC19**: `HERMOD_DISABLE_RETRY=1` + erreur 429 → 0 retry. Throw directement `HermodUpstreamError`. Log stderr `[hermod] retry disabled via HERMOD_DISABLE_RETRY`.
- **EC20**: 401 Unauthorized → **fail fast**, throw `HermodUpstreamError(httpStatus=401, upstreamCode="authentication_error", ...)`. Unifié avec HERMOD_*, narrowing consumer uniforme. Pas de `FailedAttemptEvent` (jamais passé par retry loop, cf R5b tableau).
- **EC21**: 400 Bad Request → fail fast `HermodUpstreamError(httpStatus=400, upstreamCode="invalid_request_error", ...)`. Pas de `FailedAttemptEvent`.
- **EC21b**: `ECONNREFUSED` → **fail fast** (R3m). Pas de retry, throw `HermodConfigError("Connection refused — vérifier ANTHROPIC_BASE_URL")`. **`FailedAttemptEvent(reason="connection_refused", will_retry=false)` émis avant throw** (R3m).
- **EC21c**: Exception primitive (`throw "x"`, `throw 42`) → wrap `Error(String(e))` + fail fast (R3l). `FailedAttemptEvent(reason="other")`.
- **EC21d**: N appels parallèles sur même client avec échecs → compteurs retry **isolés** par appel (R3i). Test dédié 10 parallèles × 3 tentatives, chacun avec son propre `call_id`.

### 5.3 Passthrough SDK (streaming, batches, parse, countTokens)

- **EC22**: `client.messages.stream({model: "claude-opus-4-7", ...})` appelé depuis un client Sonnet → **SDK tape Opus** (passthrough, pas d'injection). Consommateur assume (cf. §1 exception assumée). Aucun callback hermod émis. Pas de retry hermod.
- **EC22b**: `client.messages.stream({...})` sans `model` → **erreur SDK TS2345** (model requis côté SDK). Consumer doit passer explicitement le `model`. Guidance : utiliser `getModelId("claude-sonnet")` depuis bragi ou `HERMOD_BRAGI_*` constants.
- **EC23**: ~~`client.messages.create({..., stream: true})`~~ → **TS2322 à la compilation** (`HermodMessageCreateParams` exclut `stream: true` structurellement via héritage `MessageCreateParamsNonStreaming`). Le consumer forcé d'utiliser `client.messages.stream()`. Règle R3k (v1.1) supprimée car type-level enforce rend le garde-fou runtime inutile.
- **EC24**: `client.messages.countTokens({...})` → passthrough SDK direct. Pas de retry, pas de callbacks.
- **EC24b**: `client.messages.batches.create({...})` → passthrough SDK direct. Requêtes async haut volume — le consumer passe le `model` lui-même (pas d'injection hermod). Candidat wrap v2 (cf. Q4).
- **EC24c**: `client.messages.parse({...})` → passthrough SDK direct.
- **EC24d**: `client.messages instanceof Anthropic.Messages` → **false**. Le Proxy ne reproduit pas la chaîne de prototypes SDK. Code tiers qui `instanceof` doit être adapté. Documenté §2 OUT.

### 5.4 Timeout

- **EC25**: Appel dure `timeout_sec + 1s` → SDK `APITimeoutError` → hermod `HermodTimeoutError`. Retry si `attempts < max`. Historique : chaque `HermodTimeoutError` intermédiaire émet `onFailedAttempt(reason="timeout")`.
- **EC26**: Plusieurs timeouts consécutifs → budget worst-case = `max_attempts * (perCallTimeoutMs ?? timeout_sec * 1000) + sum(backoffs + retry_afters)`. Ex Sonnet (timeout 120s, max 3, base 1, cap 60) = `3 * 120 + (1+2) = 363s`. Cas Opus (180s, max 3) = `3 * 180 + (1+2) = 543s`. Consumer UI interactive DOIT utiliser `perCallTimeoutMs` court OU `AbortController` externe.
- **EC27**: Timeout bragi = `0` ou hors plage [1, 600] → `HermodConfigError` au `createClient` (R4c).
- **EC28**: `perCallTimeoutMs > bragi.timeout_sec * 1000` → tronqué au cap + warning (EC9c).
- **EC29**: Abort juste avant timeout → abort prime, `HermodAbortedError`.
- **EC30**: `duration_ms` calculé via `performance.now()` (R4d) → garantit `>= 0` même en cas de NTP correction `Date.now()`.

### 5.5 Métriques

- **EC31**: `onUsage` sync throw → catch, log debug seulement (R5a), process vivant.
- **EC32**: `onUsage` async reject → `.catch()` explicite attaché (R5a), pas d'unhandled rejection, pas de crash Node strict mode.
- **EC33**: Response sans `usage` (null, undefined, champ partiel) → `onUsage` **non invoqué**. `calculateCost` retourne 0. Pas warning log (cas courant streaming/beta).
- **EC34**: `usage.input_tokens` anormal (négatif, overflow, NaN) → `HermodConfigError` au `calculateCost` (R6c). `onUsage` non émis (erreur downstream pré-émission).
- **EC35**: Multiples `createClient` avec `onUsage` différents → isolation par instance. Callbacks distincts attachés, pas de leak cross-client.
- **EC36**: 2 appels parallèles qui terminent à la même tick event loop → `timestamp_iso` capturé pré-microtask (R5f), ordre chrono préservé même si ordre de `onUsage` invoke différent.
- **EC37**: `call_id` UUID v4 partagé entre `FailedAttemptEvent.call_id` (retries) et `UsageEvent.call_id` (succès final) → consumer aggregate via cet ID.
- **EC38**: `stop_reason: "max_tokens"` ou `"refusal"` → `onUsage` émet normalement, pas de warning hermod. Responsabilité consommateur (R5e).
- **EC39**: `onFailedAttempt` retourne Promise qui reject → même mécanisme que onUsage (R5a), catch async attaché.

### 5.6 Configuration & env

- **EC40**: `ANTHROPIC_API_KEY` absent + `baseURL` non override → SDK throw au 1er `messages.create()` (AuthenticationError) → hermod wrap en `HermodUpstreamError(httpStatus=401)`.
- **EC41**: `ANTHROPIC_BASE_URL` malformée → SDK throw au `new Anthropic()` → hermod wrap en `HermodConfigError` au `createClient`.
- **EC42**: `ANTHROPIC_BASE_URL=http://localhost:9999` (mock down) → `ECONNREFUSED` → **fail fast** `HermodConfigError("Connection refused...")` au 1er appel (EC21b, R3m). Pas 3 × timeout_sec d'attente.
- **EC43**: `HERMOD_DISABLE_RETRY` / `HERMOD_DEBUG` mutées à chaud → lues à chaque `createClient` (pas au load module), changement à chaud pris en compte.
- **EC44**: `options.baseURL` + `ANTHROPIC_BASE_URL` conflictuels → `options.baseURL` prime (R7a).

### 5.7 Cross-realm / Bundling / Distribution

- **EC45**: ESM-only, consumer CJS → `ERR_REQUIRE_ESM` actionnable FR (R13a test).
- **EC46**: Bundler tree-shaking agressif → `sideEffects: false` (R14).
- **EC47**: Worker threads / Next.js edge runtime → chaque realm ré-importe ESM, chaque realm a son propre Proxy SDK et singleton hermod. Self-check version bragi (R15b) par realm.
- **EC48**: Top-level await consumer → hermod sync à l'import. Compatible.
- **EC49**: Multiples versions hermod transitives → `instanceof HermodError` peut échouer. Fallback via `isHermodError(e)` helper (exporté) qui vérifie **whitelist exhaustive** `KNOWN_HERMOD_CODES` (pas `startsWith`). Test dédié : `throw { code: "HERMOD_FAKE" }` → `isHermodError` retourne **false**.
- **EC50**: Multiples versions bragi transitives → **bragi en peerDep (R11c)** évite structurellement ce cas. Si malgré tout 2 versions coexistent (force resolutions), self-check R15b au `createClient` détecte et throw.
- **EC51**: SDK Anthropic upgrade majeur breaking (`^0.82 → ^1.0`) → hermod pin `^0.82.0` forcera une mise à jour hermod. Doc migration README.
- **EC52**: Consumer installe hermod sans bragi → npm install **échoue** avec peerDep warning/error (selon npm version). README documente les 2 commandes.
- **EC53**: Self-check version bragi divergence major → `HermodConfigError` au 1er `createClient` (R15b).
- **EC54**: Fuite mémoire closure consumer (`onUsage` push sans bound) → documenté warning §7, pas de guard hermod.
- **EC55**: Cast `new Anthropic() as HermodClient` → **bloqué côté TS** (brand manquant, structural diff sur `messages.create` params). Si forcé via `as unknown as HermodClient`, le runtime détecte via absence `[HermodClientBrand]` au premier `messages.create` et throw... actuellement non enforcé (phantom brand = compile-time only pour minimiser overhead). Candidat durcissement runtime v1.3 si incident observé.
- **EC56**: Attaque pollution `throw { code: "HERMOD_FAKE", ... }` depuis dépendance tierce → `isHermodError` retourne **false** grâce à whitelist exhaustive `KNOWN_HERMOD_CODES` (R2a). Consumer switch tombe dans `default`/`throw e` qui remonte proprement.

---

## 6. Exemples concrets

### Cas nominal — remplace 4 call sites thor (injection model automatique)

```ts
// AVANT (thor/worker/fec-analyzer.ts)
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
const response = await client.messages.create({
  model: "claude-sonnet-4-6",        // hardcoded
  max_tokens: 8192,
  messages: [{ role: "user", content: prompt }],
});

// APRÈS (hermod + bragi, v1.2)
import { createClient } from "@tanfeuille/hermod";
const client = createClient("claude-sonnet");
const response = await client.messages.create({
  max_tokens: 8192,                   // plus de "model" — injecté par hermod
  messages: [{ role: "user", content: prompt }],
});
// Le type TS interdit `model:` ici. Le pricing, timeout, retry sont tous dérivés de "claude-sonnet".
```

### Cas 2 clients (Sonnet + Opus)

```ts
import { createClient } from "@tanfeuille/hermod";

const sonnet = createClient("claude-sonnet");   // timeout 120s, max 3 retries
const opus = createClient("claude-opus");        // timeout 180s, max 3 retries

// Extraction rapide (Sonnet)
const extraction = await sonnet.messages.create({
  max_tokens: 4096,
  messages: [{ role: "user", content: "Extract fields from this invoice" }],
});

// Décision structurante (Opus)
const decision = await opus.messages.create({
  max_tokens: 8192,
  messages: [{ role: "user", content: "Analyze risk of this pattern" }],
});
```

### Cas streaming (passthrough SDK — consumer passe explicitement le model)

```ts
import { createClient } from "@tanfeuille/hermod";
import { getModelId } from "@tanfeuille/bragi";

const client = createClient("claude-sonnet");

// stream est passthrough SDK. Le consumer passe le model explicitement (pas d'injection hermod).
// Il DOIT aligner avec le canonicalName du client pour cohérence (responsabilité consumer).
const stream = client.messages.stream({
  model: getModelId("claude-sonnet"),   // ou HERMOD_BRAGI_* constants
  max_tokens: 4096,
  messages: [{ role: "user", content: "Explain step by step" }],
});

for await (const event of stream) {
  // Pas de retry hermod sur stream interrompu — responsabilité consumer.
  // Pas de callbacks onUsage/onFailedAttempt — calculateCost() manuel si besoin.
  console.log(event);
}
```

### Cas bifrost avec onUsage + onFailedAttempt + perCallTimeoutMs + narrowing unifié

```ts
// bifrost, app/api/agents/analyze-rules/route.ts
import { createClient, calculateCost, isHermodError, isAnthropicSdkError } from "@tanfeuille/hermod";

export async function POST(req: Request) {
  const client = createClient("claude-sonnet", {
    perCallTimeoutMs: 60_000,         // Vercel function 60s max (< bragi 120s cap)
    onUsage: async (event) => {
      await supabase.from("llm_calls").insert({
        call_id: event.call_id,
        consumer: "bifrost-analyze-rules",
        model: event.canonical_name,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cost_eur: event.cost_eur,
        duration_ms: event.duration_ms,
        timestamp: event.timestamp_iso,
      });
    },
    onFailedAttempt: async (event) => {
      // Log coûts fantômes + debug batch
      await supabase.from("llm_failed_attempts").insert({
        call_id: event.call_id,
        canonical_name: event.canonical_name,
        attempt: event.attempt,
        reason: event.reason,              // "timeout" | "network" | "connection_refused" | "429" | "5xx" | "abort" | "other"
        error_code: event.error_code,
        http_status: event.http_status,
        retry_after_ms: event.retry_after_ms,
        will_retry: event.will_retry,
        timestamp: event.timestamp_iso,
      });
    },
  });

  try {
    const response = await client.messages.create({
      max_tokens: 4096,
      messages: [...],
    });
    return Response.json({ result: response.content });
  } catch (e) {
    // Narrowing unifié via whitelist exhaustive — resist pollution
    if (isHermodError(e)) {
      switch (e.code) {
        case "HERMOD_CONFIG_ERROR":
          return Response.json({ error: "Configuration invalide" }, { status: 500 });
        case "HERMOD_TIMEOUT":
          return Response.json({ error: "Délai dépassé, réessayer" }, { status: 504 });
        case "HERMOD_RETRY_EXHAUSTED":
          // e.attemptsHistory permet le debug complet
          console.error("Retry history:", e.attemptsHistory);
          // e.lastError peut être HermodTimeoutError | HermodUpstreamError(5xx) | HermodNetworkError
          if (e.lastError.code === "HERMOD_UPSTREAM") {
            return Response.json(
              { error: `Service Anthropic indisponible (${e.lastError.httpStatus})` },
              { status: 503 }
            );
          }
          return Response.json({ error: "Service Claude indisponible" }, { status: 503 });
        case "HERMOD_ABORTED":
          return Response.json({ error: "Requête annulée" }, { status: 499 });
        case "HERMOD_UPSTREAM":
          // 401/403/400/404/etc. uniformes ici (4xx fail-fast seulement)
          return Response.json(
            { error: `Erreur amont Anthropic (${e.httpStatus})` },
            { status: e.httpStatus >= 500 ? 502 : 400 }
          );
      }
    }
    // Cas exceptionnel : erreur SDK non-catégorisée par hermod
    // (ex : erreur depuis passthrough streaming/batches/parse où hermod n'intervient pas)
    if (isAnthropicSdkError(e)) {
      console.error("[anthropic-sdk raw]", e.status, e.message);
      return Response.json({ error: "Erreur SDK non-classée" }, { status: 500 });
    }
    throw e;  // Erreur système ou bug code, remonter
  }
}
```

### Cas AbortSignal + perCallTimeoutMs combinés

```ts
import { createClient } from "@tanfeuille/hermod";

const controller = new AbortController();
setTimeout(() => controller.abort("Budget global 30s"), 30_000);

const client = createClient("claude-haiku", {
  signal: controller.signal,
  perCallTimeoutMs: 10_000,    // chaque tentative max 10s
});

// Budget effectif : min(30s global abort, 10s × max_attempts + backoffs)
```

### Cas calculateCost hors client (historique)

```ts
import { calculateCost } from "@tanfeuille/hermod";

const historicCalls = await db.query("SELECT usage, canonical_name FROM llm_calls");
const totalCost = historicCalls.reduce(
  (sum, row) => sum + calculateCost(row.usage as Anthropic.Messages.Usage, row.canonical_name),
  0,
);
```

### Cas debug batch via attemptsHistory

```ts
try {
  await client.messages.create({ max_tokens: 4096, messages: [...] });
} catch (e) {
  if (isHermodError(e) && e.code === "HERMOD_RETRY_EXHAUSTED") {
    // Historique complet des tentatives
    for (const entry of e.attemptsHistory) {
      console.log(`Tentative ${entry.attempt}: ${entry.error_code} en ${entry.elapsed_ms}ms — ${entry.error_message}`);
    }
    // Exemple output :
    // Tentative 1: ECONNRESET en 1200ms — Connection reset by peer
    // Tentative 2: 504 en 120000ms — Gateway Timeout
    // Tentative 3: 504 en 120000ms — Gateway Timeout
  }
}
```

### Cas traçabilité consumer

```ts
import {
  HERMOD_VERSION, HERMOD_BRAGI_VERSION, HERMOD_BRAGI_URD_HASH,
  HERMOD_BRAGI_URD_DATE, HERMOD_SDK_VERSION,
} from "@tanfeuille/hermod";

console.log(
  `[hermod] consumer=thor-worker, hermod=${HERMOD_VERSION}, ` +
  `bragi=${HERMOD_BRAGI_VERSION}, sdk=${HERMOD_SDK_VERSION}, ` +
  `urd_hash=${HERMOD_BRAGI_URD_HASH.slice(0, 8)}, urd_date=${HERMOD_BRAGI_URD_DATE}`,
);
```

---

## 7. Dépendances & contraintes

### Techniques

- **Runtime Node** : `>=20`, ESM strict, TS resolution `NodeNext`.
- **Target TS** : `ES2022`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **Consommateurs minimum** : Node ≥20, target TS ≥ES2020, ESM uniquement.
- **Build** : `tsc` → `dist/` contient `*.js` + `*.d.ts` + `*.js.map`.
- **Test runner** : `vitest ^4.1.2` avec `vi.mock("@anthropic-ai/sdk")`.
- **Dépendances runtime** :
  - `@anthropic-ai/sdk` `^0.82.0` (wrapping principal).
- **Dépendances peer** (consumer DOIT installer explicitement) :
  - `@tanfeuille/bragi` `^0.1.0` (config source). R11c.
- **Dépendances dev** (pinned) :
  - `@tanfeuille/bragi` `^0.1.0` (aligné avec peerDep pour tests + build)
  - `typescript` `"^5.7.0"`
  - `vitest` `"^4.1.2"`
  - `@types/node` `"^22.0.0"`
- **Dépendances interdites** (testées) :
  - PAS de `js-yaml`.
  - PAS de `langchain`, `openai`, autres SDK LLM.
  - PAS de `axios`, `node-fetch` direct (undici transitive SDK OK).
  - PAS de `@supabase/supabase-js`, SDKs cloud.
  - PAS de dep filesystem.
- **`package-lock.json`** committé.
- **Publication** : `@tanfeuille/hermod` sur `https://npm.pkg.github.com`. Gate CI : test + lint + build + check-sync-bragi + publish sur tag `v*`.
- **Install consommateur** (DEUX commandes) :
  ```bash
  npm install @tanfeuille/hermod @tanfeuille/bragi
  # OU dev sibling
  npm install file:../wincorp-hermod file:../wincorp-bragi
  ```

### Performance

- `createClient` sans callbacks : **< 2 ms** (Proxy + lookup bragi cached + self-check memoized).
- `createClient` avec callbacks : **< 3 ms** (wrap closure).
- `calculateCost` : **< 0.05 ms**.
- Overhead retry custom vs SDK natif : **< 0.5 ms** par tentative.
- Memory footprint : **< 10 KB** par client instance (hors SDK interne).

### Sécurité

- API key jamais loggée (R7b, R10, tests dédiés).
- Redaction regex sur toute valeur suspecte avant inclusion dans message/stack.
- Pas d'accès filesystem/réseau au load (R11, test dédié).
- BaseURL loggée hostname uniquement (R7c).
- `onUsage` / `onFailedAttempt` callbacks isolés (try/catch sync + .catch async), zéro propagation d'exception consumer.
- `isHermodError` whitelist exhaustive anti pollution.

### Compatibilité SDK Anthropic

- **v0.82.x** : version plancher minor. Stable.
- **v0.83+, v0.84+** : compat attendue sans change hermod.
- **v1.0.0 breaking futur** : bump hermod minor, doc migration.

### Avertissements consumer

- **Retry storm sur batch lourd** : hermod n'a pas de circuit breaker (R3o). Consommateur qui fait > 10 appels/min et risque outage Anthropic 503 → implémenter circuit breaker local (memoize last failure + cooldown) OU utiliser odin Python.
- **Fuite mémoire `onUsage`** : closure qui accumule sans bound peut fuiter en long running (worker VPS). Flush périodique (Supabase, file) ou ring buffer recommandés.
- **Passthrough streaming/batches/parse sans garantie modèle** : le consommateur qui utilise `client.messages.stream()`, `client.messages.batches.*`, `client.messages.parse()` ou `client.messages.countTokens()` passe le `model` explicitement ; hermod ne vérifie pas qu'il corresponde au `canonicalName` du client. Responsabilité consumer de rester cohérent (passer `getModelId(canonicalName)`).
- **`client.messages instanceof Anthropic.Messages` est false**. Le Proxy ne reproduit pas la chaîne de prototypes SDK.

---

## 8. Changelog

| Version | Date | Modification |
|---------|------|--------------|
| 1.0 | 2026-04-21 | Création initiale DRAFT. Phase 10.1 DeerFlow, séparation de bragi. Scope : `createClient` + `calculateCost` + 4 erreurs, retry custom, timeout, métriques opt-in. |
| 1.1 | 2026-04-21 | Révision post-audit adversarial 3 agents Opus (silent-failure + type-design + edge-cases). **7 décisions structurantes actées + 6 EC obligatoires + corrections EC existants**. Changements majeurs : (1) Proxy injection automatique du `model` ; (2) `HermodUpstreamError` wrap uniforme ; (3) `onFailedAttempt` + `attemptsHistory` ; (4) `perCallTimeoutMs` ; (5) Bragi en `peerDependencies` ; (6) Streaming passthrough ; (7) Self-check runtime version bragi. 54 EC couverts. |
| 1.2 | 2026-04-21 | Révision post re-audit type-design v1.1 (scores 7/7/8/6 → projection 8/9/9/8). **3 bloquants + 3 HIGH + 1 trivial corrigés** : (C-a) `HermodMessageCreateParams` exclut `stream:true` structurellement → R3k/EC23 v1.1 supprimés comme garde-fou runtime superflu, TS enforce suffit ; (C-b) exposition `batches` + `parse` en passthrough dans `HermodClient.messages` (symétrique `stream`/`countTokens`) — réconcilie §2 OUT v1.1 qui promettait accès SDK brut sans l'exposer ; (C-2 brand) phantom brand `declare const HermodClientBrand: unique symbol` stampé runtime par le Proxy (R11d) — empêche assignation d'un `new Anthropic()` ; (H-c) `isHermodError` whitelist exhaustive `KNOWN_HERMOD_CODES` au lieu de `startsWith("HERMOD_")` permissif (anti pollution `{code:"HERMOD_FAKE"}`) ; (H-d) clarification §3.4 frontière `HermodUpstreamError` vs `HermodRetryExhaustedError.lastError` + matrice R3d avec colonne "classification finale" ; (H-e) mapping `FailedAttemptEvent.reason` exhaustif incluant `"connection_refused"` (ECONNREFUSED émet quand même un event avant fail-fast) ; (M-9) `HermodConfigError.cause?: unknown \| undefined` + `canonicalName?: string \| undefined` explicites (cohabite avec `exactOptionalPropertyTypes`). **Ajouts §1 "exceptions assumées à l'invariant"** pour streaming/batches/parse — documente explicitement la tension scope. **56 EC couverts** (ajouts EC22b, EC24b-d, EC55, EC56). |

---

## Questions ouvertes (hors spec v1.x)

- **Q1 — Circuit breaker mémoire simple** : miroir odin léger, sans persistance. Candidat v2 si friction batch TS apparaît.
- **Q2 — `stop_reason` dans `UsageEvent`** : exposer pour observabilité fine. Candidat v1.3 (non-breaking, champ additionnel).
- **Q3 — Wrapping `messages.stream()` avec métriques fin-de-stream** : via `message_delta` event SDK. Candidat v1.3.
- **Q4 — Support `messages.batches` API avec injection** : async haut volume, tracking cost fantôme. Candidat v2.
- **Q5 — Budget timeout global cumulé** (pas per-attempt) : alternative à AbortController. Candidat v1.3.
- **Q6 — Métriques retry dans `UsageEvent`** : `attempts_count` + `retry_total_ms`. Couplé à `onFailedAttempt` + aggregate par `call_id` v1.1, candidat enrichissement v1.3.
- **Q7 — Support multi-provider** : OpenAI, Mistral, DeepSeek. Candidat v2.0 breaking.
- **Q8 — Prompt caching auto** : détection patterns cacheable + injection `cache_control`. Responsabilité consumer v1.x.
- **Q9 — Hot-reload config bragi** : rejeté (bragi statique par design).
- **Q10 — Enforce plage timeout + max_attempts côté bragi** : remontée spec bragi v1.2 (R4c + R3n côté hermod sont des check défensifs, duplicata d'enforce à centraliser).
- **Q11 — Durcissement runtime phantom brand** : actuellement brand compile-time + stamp runtime informatif. Enforce runtime (throw si brand manquant au 1er `create`) à évaluer v1.3 si incident observé (cf. EC55).
- **Q12 — Wrap injection model sur `batches.create` et `parse`** : actuellement passthrough sans garantie. Candidat v2 si pattern d'usage récurrent émerge.
