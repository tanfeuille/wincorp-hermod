// @spec specs/hermod-client.spec.md v1.2 §4.1 R2d + §4.3 R4 + R15b
//
// createClient : instance SDK Anthropic wrappée via Proxy.
// - Injection automatique du `model` dans messages.create (invariant central)
// - Passthrough pour stream/countTokens/batches/parse
// - Phantom brand stampé runtime R11d
// - Self-check version bragi R15b
// - Retry custom + callbacks onUsage/onFailedAttempt

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import {
  getModelConfig,
  getModelId,
  BRAGI_VERSION,
  type CanonicalModelName,
} from "@tanfeuille/bragi";
import {
  HERMOD_BRAGI_VERSION,
} from "./metadata.generated.js";
import { HermodConfigError } from "./errors.js";
import { executeWithRetry, type RetryContext } from "./retry.js";
import { buildUsageEvent, emitUsageEvent } from "./metrics.js";
import {
  type HermodClient,
  type HermodClientOptions,
  type HermodMessageCreateParams,
  HermodClientBrand,
} from "./types.js";

const TIMEOUT_SEC_MIN = 1;
const TIMEOUT_SEC_MAX = 600;

// =============================================================================
// Self-check version bragi (R15b, memoized)
// =============================================================================

let _selfCheckDone = false;

function runVersionSelfCheck(): void {
  if (_selfCheckDone) return;

  const buildVersion = HERMOD_BRAGI_VERSION;
  const runtimeVersion = BRAGI_VERSION;

  if (buildVersion === runtimeVersion) {
    _selfCheckDone = true;
    return;
  }

  const [buildMajor, buildMinor] = parseSemver(buildVersion);
  const [runMajor, runMinor] = parseSemver(runtimeVersion);

  // Divergence major ou minor → throw
  if (buildMajor !== runMajor || buildMinor !== runMinor) {
    throw new HermodConfigError(
      `Version bragi incohérente : hermod lié à bragi@${buildVersion} au build, ` +
        `runtime résout bragi@${runtimeVersion}. Aligner via : ` +
        `\`npm install @tanfeuille/bragi@${buildVersion}\` OU ` +
        `\`npm install @tanfeuille/hermod@latest\`.`,
    );
  }

  // Divergence patch → warning debug seulement
  if (process.env["HERMOD_DEBUG"] === "1") {
    // eslint-disable-next-line no-console
    console.warn(
      `[hermod] version bragi patch drift : build=${buildVersion}, runtime=${runtimeVersion} (OK, même minor).`,
    );
  }

  _selfCheckDone = true;
}

function parseSemver(version: string): [number, number, number] {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = Number.isInteger(parts[0]) ? parts[0]! : 0;
  const minor = Number.isInteger(parts[1]) ? parts[1]! : 0;
  const patch = Number.isInteger(parts[2]) ? parts[2]! : 0;
  return [major, minor, patch];
}

/** Exposé pour tests. */
export function _resetVersionSelfCheckForTests(): void {
  _selfCheckDone = false;
}

// =============================================================================
// Validation options
// =============================================================================

function resolveTimeoutMs(
  bragiTimeoutSec: number,
  perCallTimeoutMs: number | undefined,
  canonicalName: CanonicalModelName,
): number {
  // R4c — plage bragi
  if (bragiTimeoutSec < TIMEOUT_SEC_MIN || bragiTimeoutSec > TIMEOUT_SEC_MAX) {
    throw new HermodConfigError(
      `Config bragi timeout_sec=${bragiTimeoutSec} hors plage [${TIMEOUT_SEC_MIN}, ${TIMEOUT_SEC_MAX}].`,
      undefined,
      canonicalName,
    );
  }

  const bragiCapMs = bragiTimeoutSec * 1000;

  if (perCallTimeoutMs === undefined) return bragiCapMs;

  if (typeof perCallTimeoutMs !== "number" || !Number.isFinite(perCallTimeoutMs) || perCallTimeoutMs < 1) {
    throw new HermodConfigError(
      `options.perCallTimeoutMs doit être un nombre >= 1 (reçu : ${perCallTimeoutMs}).`,
      undefined,
      canonicalName,
    );
  }

  if (perCallTimeoutMs > bragiCapMs) {
    if (process.env["HERMOD_DEBUG"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `[hermod] perCallTimeoutMs=${perCallTimeoutMs} tronqué au cap bragi=${bragiCapMs} (modèle ${canonicalName}).`,
      );
    }
    return bragiCapMs;
  }

  return perCallTimeoutMs;
}

// =============================================================================
// createClient
// =============================================================================

export function createClient(
  canonicalName: CanonicalModelName,
  options?: HermodClientOptions,
): HermodClient {
  // Self-check version bragi (R15b)
  runVersionSelfCheck();

  // Lookup bragi — wrap en HermodConfigError si throw (R2)
  let bragiConfig;
  let canonicalId;
  try {
    bragiConfig = getModelConfig(canonicalName);
    canonicalId = getModelId(canonicalName);
  } catch (e) {
    throw new HermodConfigError(
      `Impossible de créer le client : bragi.getModelConfig("${canonicalName}") a échoué.`,
      e,
      canonicalName,
    );
  }

  // Résolution timeout
  const timeoutMs = resolveTimeoutMs(bragiConfig.timeout_sec, options?.perCallTimeoutMs, canonicalName);

  // Log debug signal déjà aborté au createClient (EC5)
  if (options?.signal?.aborted && process.env["HERMOD_DEBUG"] === "1") {
    // eslint-disable-next-line no-console
    console.warn(`[hermod] signal déjà aborté à createClient (modèle ${canonicalName}).`);
  }

  // Instanciation SDK (maxRetries: 0 — hermod gère le retry)
  const sdkOptions: Record<string, unknown> = {
    timeout: timeoutMs,
    maxRetries: 0,
  };
  if (options?.baseURL !== undefined) {
    sdkOptions["baseURL"] = options.baseURL;
  }
  if (options?.apiKey !== undefined) {
    sdkOptions["apiKey"] = options.apiKey;
  }

  let sdkInstance: Anthropic;
  try {
    sdkInstance = new Anthropic(sdkOptions);
  } catch (e) {
    throw new HermodConfigError(
      `Échec instanciation SDK Anthropic : ${(e as Error).message ?? e}`,
      e,
      canonicalName,
    );
  }

  // Wrap messages object (inject model + retry + callbacks)
  const wrappedMessages = buildWrappedMessages(
    sdkInstance,
    canonicalName,
    canonicalId,
    timeoutMs,
    bragiConfig,
    options ?? {},
  );

  // Proxy top-level : intercept 'messages', passthrough autres props
  const proxied = new Proxy(sdkInstance, {
    get(target, prop, receiver) {
      if (prop === "messages") return wrappedMessages;
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxied as unknown as HermodClient;
}

// =============================================================================
// Wrapped messages
// =============================================================================

function buildWrappedMessages(
  sdk: Anthropic,
  canonicalName: CanonicalModelName,
  canonicalId: ReturnType<typeof getModelId>,
  timeoutMs: number,
  bragiConfig: ReturnType<typeof getModelConfig>,
  options: HermodClientOptions,
): HermodClient["messages"] {
  const disableRetry = process.env["HERMOD_DISABLE_RETRY"] === "1";

  const wrapped: HermodClient["messages"] = {
    [HermodClientBrand]: true,

    create: async (params: HermodMessageCreateParams, reqOptions?: Anthropic.RequestOptions) => {
      const callId = randomUUID();
      const startTimeMs = performance.now();

      const ctx: RetryContext = {
        canonicalName,
        canonicalId,
        timeoutMs,
        retry: bragiConfig.retry,
        callId,
        signal: options.signal,
        onFailedAttempt: options.onFailedAttempt,
        disableRetry,
      };

      const result = await executeWithRetry(async (attemptSignal) => {
        // Merge request options: prefer caller's requestOptions but always use attempt signal
        const mergedOptions: Anthropic.RequestOptions = {
          ...(reqOptions ?? {}),
          signal: attemptSignal,
        };
        // Injection automatique du model
        const paramsWithModel = {
          ...params,
          model: canonicalId,
        } as Anthropic.Messages.MessageCreateParamsNonStreaming;
        return await sdk.messages.create(paramsWithModel, mergedOptions);
      }, ctx);

      const durationMs = performance.now() - startTimeMs;

      // Emit onUsage si response a un usage
      if (result.usage) {
        const event = buildUsageEvent(result.usage, {
          callId,
          canonicalName,
          durationMs,
          timestampIso: new Date().toISOString(),
        });
        emitUsageEvent(options.onUsage, event);
      }

      return result;
    },

    stream: sdk.messages.stream.bind(sdk.messages),
    countTokens: sdk.messages.countTokens.bind(sdk.messages),
    batches: sdk.messages.batches,
  };

  return wrapped;
}
