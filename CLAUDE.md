# wincorp-hermod

**Yggdrasil** : Hermod — messager des dieux. Porte les messages entre WinCorp et Anthropic avec retry, timeout et métriques uniformes. Branche Tronc (transverse).

## Identité

Package TypeScript **wrapper SDK `@anthropic-ai/sdk`** aligné sur la config LLM Yggdrasil exposée par `@tanfeuille/bragi`. Proxy injection model auto, retry natif (matrice R3d), timeout bragi, métriques opt-in.

**Peer dep** : `@tanfeuille/bragi` (runtime check version).

## Règles locales

- **Source modèles** : jamais d'ID hardcodé. Toujours via `bragi.getModel("canonical-name")`.
- **Retry policy** : retry automatique sur codes transient (429, 503, 529). Override possible par appel.
- **Timeout par appel** : `perCallTimeoutMs` configurable, sinon fallback bragi config.
- **Wrap uniforme** : toute erreur Anthropic SDK → `HermodUpstreamError` (preserve `.cause`).
- **Publication** : GitHub Packages `npm.pkg.github.com/@tanfeuille/hermod` (public).

## API principale

- `createClient(canonicalName, opts?)` → Proxy Anthropic.Client
- `callVisionModelHermod(...)` → helper Vision
- `callTextModelHermod(...)` → helper text

## Dépendance

- Peer dep : `wincorp-bragi` (config canonique).
- Consommateurs : `wincorp-thor` (Image v2 + Achats + FEC worker), `wincorp-bifrost` (5 routes API).

## Documentation

Voir `README.md` pour usage détaillé et `specs/` pour contrat IMPLEMENTED (v1.2.0+).

## Convention commits

Conventional Commits FR. 1 commit = 1 changement logique.
