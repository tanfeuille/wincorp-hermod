# @tanfeuille/hermod

**Hermod** — messager des dieux nordiques. Wrapper TypeScript du SDK `@anthropic-ai/sdk`, aligné sur la config LLM Yggdrasil exposée par `@tanfeuille/bragi`. Porte les messages entre WinCorp et Anthropic avec retry, timeout et métriques uniformes.

> Dans l'Edda, Hermod est celui qui chevauche Sleipnir pour porter les messages les plus critiques. Ici, c'est le package qui transporte tous les prompts Claude de l'écosystème TypeScript.

## Position dans Yggdrasil

**Tronc** (transverse). Complément TypeScript actif de [`@tanfeuille/bragi`](https://github.com/tanfeuille/wincorp-bragi) (config pure).

```
@tanfeuille/bragi (config pure, zéro dep)
    ↓
@tanfeuille/hermod (ce package — wrapper SDK)
    ↓
wincorp-thor + wincorp-bifrost (consommateurs)
```

Côté Python, l'équivalent est [`wincorp-odin`](https://github.com/tanfeuille/wincorp-odin) (factory LangChain + circuit breaker + tracking tokens).

**Différence hermod vs odin** : hermod est volontairement plus léger (retry simple, timeout, métriques). Le circuit breaker + tracking tokens persistant restent côté odin Python (pour les pipelines heimdall/worker batch). Si côté TS on a besoin de fonctionnalités lourdes (circuit breaker distribué, supabase sink), on les ajoute à hermod v2+.

## Ce que fait Hermod

- **`createClient(canonicalName)`** — instancie un client Anthropic SDK pré-configuré avec timeout/retry dérivés de la config bragi, prêt à appeler `.messages.create()`.
- **Retry intelligent** — rejoue les erreurs transitoires (429, 5xx, timeout réseau) avec backoff exponentiel selon params `retry` du YAML.
- **Timeout unifié** — chaque client respecte le `timeout_sec` canonique de bragi (60s Haiku, 120s Sonnet, 180s Opus).
- **Métriques runtime** — compte tokens input/output, calcule coût EUR via `getPricing()` de bragi, émet des events typés (hooks ou callback).
- **Env-aware** — supporte `ANTHROPIC_BASE_URL` override (mock/proxy local).

## Ce que Hermod NE fait PAS

- Pas de persistance des métriques (les consommateurs décident : log console, Supabase, Grafana, etc.).
- Pas de circuit breaker — si besoin, côté odin Python ou v2+ hermod.
- Pas de gestion prompt caching (responsabilité consommateur, éventuelle v1.1 si pattern émerge).
- Pas d'abstraction multi-provider (OpenAI, Mistral) — uniquement Anthropic en v1.0.

## Exemples

```ts
import { createClient, HermodError } from "@tanfeuille/hermod";
import { getPricing } from "@tanfeuille/bragi";

// Instanciation pré-configurée
const client = createClient("claude-sonnet");
// client est un Anthropic SDK avec timeout+retry+métriques

// Usage standard SDK
try {
  const response = await client.messages.create({
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello Claude" }],
  });
  console.log(response.content);

  // Calcul coût post-appel (bragi pricing + usage SDK)
  const p = getPricing("claude-sonnet");
  const cost = (response.usage.input_tokens * p.input_per_million_eur
              + response.usage.output_tokens * p.output_per_million_eur) / 1e6;
  console.log(`Coût: ${cost.toFixed(4)} EUR`);
} catch (e) {
  if (e instanceof HermodError) {
    console.error(`[${e.code}] ${e.message}`);
  }
}

// Avec callback métriques
const clientWithMetrics = createClient("claude-haiku", {
  onUsage: (event) => {
    // event: { canonical_name, input_tokens, output_tokens, cost_eur, duration_ms }
    supabaseLog(event);
  },
});
```

## Installation

### Dev local (mode sibling)

```
workspace/
├── wincorp-bragi/
├── wincorp-hermod/
└── wincorp-thor/
```

Dans `wincorp-thor/package.json` :

```json
{
  "dependencies": {
    "@tanfeuille/bragi": "file:../wincorp-bragi",
    "@tanfeuille/hermod": "file:../wincorp-hermod"
  }
}
```

### Prod (GitHub Packages)

Même `.npmrc` + PAT que bragi (cf. [README bragi](https://github.com/tanfeuille/wincorp-bragi#en-prod)) :

```json
{
  "dependencies": {
    "@tanfeuille/hermod": "^0.1.0"
  }
}
```

Hermod porte bragi en dep transitive automatiquement.

## Développement

```bash
npm install
npm test
npm run test:watch
npm run build
npm run lint
```

## Spec

Voir `specs/hermod-client.spec.md` (SDD Niveau 2, DRAFT v1.0).

## Licence

UNLICENSED — usage interne WinCorp uniquement.
