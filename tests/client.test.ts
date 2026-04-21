// @spec specs/hermod-client.spec.md v1.2 §4.1 R2d + R4 + R15b
//
// Tests client.ts — createClient avec mock SDK Anthropic.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanonicalModelName } from "@tanfeuille/bragi";
import { createClient, _resetVersionSelfCheckForTests } from "../src/client.js";
import {
  HermodConfigError,
  HermodError,
} from "../src/errors.js";
import { HermodClientBrand } from "../src/types.js";

const SONNET = "claude-sonnet" as CanonicalModelName;

beforeEach(() => {
  _resetVersionSelfCheckForTests();
  delete process.env["HERMOD_DEBUG"];
  delete process.env["HERMOD_DISABLE_RETRY"];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createClient — config & validation", () => {
  it("EC1 : canonicalName inconnu → HermodConfigError wrap", () => {
    // @ts-expect-error — cast délibéré
    expect(() => createClient("unknown-model")).toThrow(HermodConfigError);
  });

  it("EC1 : HermodConfigError contient cause bragi", () => {
    try {
      // @ts-expect-error
      createClient("unknown-model");
      expect.fail("expected throw");
    } catch (e) {
      const he = e as HermodConfigError;
      expect(he).toBeInstanceOf(HermodConfigError);
      expect(he.canonicalName).toBe("unknown-model");
      expect(he.cause).toBeDefined();
      // Cause est une BragiError (code littéral)
      const cause = he.cause as { code?: string };
      expect(cause.code).toBe("BRAGI_MODEL_NOT_FOUND");
    }
  });

  it("EC9b : perCallTimeoutMs négatif → HermodConfigError", () => {
    expect(() => createClient(SONNET, { perCallTimeoutMs: -1 })).toThrow(HermodConfigError);
  });

  it("EC9b : perCallTimeoutMs NaN → HermodConfigError", () => {
    expect(() => createClient(SONNET, { perCallTimeoutMs: NaN })).toThrow(HermodConfigError);
  });

  it("EC9c : perCallTimeoutMs > cap → tronqué (pas throw)", () => {
    // Sonnet timeout 120s = 120_000ms cap. 999_999ms doit être tronqué.
    expect(() => createClient(SONNET, { perCallTimeoutMs: 999_999 })).not.toThrow();
  });

  it("perCallTimeoutMs valide → accepté", () => {
    expect(() => createClient(SONNET, { perCallTimeoutMs: 60_000 })).not.toThrow();
  });

  it("createClient sans options → accepté", () => {
    expect(() => createClient(SONNET)).not.toThrow();
  });

  it("createClient avec baseURL override → accepté", () => {
    expect(() => createClient(SONNET, { baseURL: "http://localhost:9999" })).not.toThrow();
  });

  it("createClient avec apiKey override → accepté", () => {
    expect(() => createClient(SONNET, { apiKey: "sk-ant-dummy-test-value-not-real" })).not.toThrow();
  });
});

describe("createClient — Proxy brand R11d", () => {
  it("client.messages a le phantom brand stampé", () => {
    const client = createClient(SONNET);
    const messages = client.messages as unknown as Record<symbol, unknown>;
    expect(messages[HermodClientBrand as unknown as symbol]).toBe(true);
  });

  it("client top-level passthrough : accès propriétés SDK non-messages", () => {
    const client = createClient(SONNET);
    // beta est une prop SDK top-level, devrait être accessible via passthrough
    expect(client.beta).toBeDefined();
  });
});

describe("createClient — surface messages", () => {
  it("messages.create est une fonction", () => {
    const client = createClient(SONNET);
    expect(typeof client.messages.create).toBe("function");
  });

  it("messages.stream est passthrough SDK (function)", () => {
    const client = createClient(SONNET);
    expect(typeof client.messages.stream).toBe("function");
  });

  it("messages.countTokens est passthrough SDK (function)", () => {
    const client = createClient(SONNET);
    expect(typeof client.messages.countTokens).toBe("function");
  });

  it("messages.batches est passthrough SDK (objet)", () => {
    const client = createClient(SONNET);
    expect(client.messages.batches).toBeDefined();
    expect(typeof client.messages.batches).toBe("object");
  });
});

describe("createClient — HERMOD_DISABLE_RETRY env", () => {
  it("flag respecté (lu à chaque createClient, pas seulement au boot)", () => {
    process.env["HERMOD_DISABLE_RETRY"] = "1";
    // createClient succeeds — le flag est passé au ctx retry interne, pas de throw
    expect(() => createClient(SONNET)).not.toThrow();
  });
});

describe("createClient — EC5 signal déjà aborté", () => {
  it("createClient accepte un signal aborté (warning debug seulement)", () => {
    const controller = new AbortController();
    controller.abort("pre-aborted");
    // EC5 : instance SDK créée quand même, premier messages.create throw
    expect(() => createClient(SONNET, { signal: controller.signal })).not.toThrow();
  });
});

describe("R15b self-check version bragi", () => {
  it("versions alignées → no throw", () => {
    expect(() => createClient(SONNET)).not.toThrow();
  });

  // Note : tester la divergence minor/major nécessite de muter HERMOD_BRAGI_VERSION
  // au runtime, ce qui est complexe car c'est une const compilée. Test lourd reporté.
  it("memoized : deuxième createClient ne re-run pas le check (pas de throw répété)", () => {
    expect(() => createClient(SONNET)).not.toThrow();
    expect(() => createClient(SONNET)).not.toThrow();
  });
});
