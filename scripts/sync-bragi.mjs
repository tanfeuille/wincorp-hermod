// @spec specs/hermod-client.spec.md v1.2 R16
// Script sync-bragi : lit node_modules/@tanfeuille/bragi/* et génère
// src/metadata.generated.ts avec toutes les constantes HERMOD_BRAGI_*,
// HERMOD_SDK_VERSION, HERMOD_BUILD_AT.
//
// Usage :
//   node scripts/sync-bragi.mjs
//
// Exécuté en npm prepare hook + CI pre-build. Idempotent.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HERMOD_ROOT = resolve(__dirname, "..");

/**
 * Lit un package.json et retourne le champ version.
 */
export async function readPackageVersion(pkgJsonPath) {
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`package.json introuvable : ${pkgJsonPath}`);
  }
  const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  if (typeof pkg.version !== "string") {
    throw new Error(`Champ 'version' manquant ou invalide dans ${pkgJsonPath}`);
  }
  return pkg.version;
}

/**
 * Extrait les constantes BRAGI_URD_HASH + BRAGI_URD_DATE depuis le JS compilé.
 * Si bragi n'est pas buildé (dist/ absent), lit le source ts comme fallback.
 */
export async function readBragiMetadata(bragiRoot) {
  const distPath = resolve(bragiRoot, "dist", "models.generated.js");
  const srcPath = resolve(bragiRoot, "src", "models.generated.ts");
  const candidatePath = existsSync(distPath) ? distPath : srcPath;

  if (!existsSync(candidatePath)) {
    throw new Error(
      `bragi models.generated introuvable (ni dist ni src). ` +
        `Lancer d'abord : (cd ${bragiRoot} && npm run sync-models && npm run build).`,
    );
  }

  const content = await readFile(candidatePath, "utf8");
  const hashMatch = content.match(/BRAGI_URD_HASH\s*=\s*"([a-f0-9]{64})"/);
  const dateMatch = content.match(/BRAGI_URD_DATE\s*=\s*"([^"]+)"/);

  if (!hashMatch || !dateMatch) {
    throw new Error(
      `bragi models.generated ne contient pas BRAGI_URD_HASH / BRAGI_URD_DATE. ` +
        `Fichier lu : ${candidatePath}. Régénérer via (cd ${bragiRoot} && npm run sync-models).`,
    );
  }

  return { urdHash: hashMatch[1], urdDate: dateMatch[1] };
}

/**
 * Génère le contenu TS de src/metadata.generated.ts.
 */
export function generateMetadataContent({
  hermodVersion,
  bragiVersion,
  urdHash,
  urdDate,
  sdkVersion,
  nodeVersion = process.versions.node,
  generatedAt = new Date().toISOString(),
}) {
  return `// @generated — DO NOT EDIT MANUALLY
// @spec specs/hermod-client.spec.md v1.2 R16
//
// Métadonnées embarquées au build pour traçabilité + self-check R15b.
// Régénéré par : npm run sync-bragi (hook prepare + CI pre-build).

export const HERMOD_VERSION = ${JSON.stringify(hermodVersion)} as const;
export const HERMOD_BRAGI_VERSION = ${JSON.stringify(bragiVersion)} as const;
export const HERMOD_BRAGI_URD_HASH = ${JSON.stringify(urdHash)} as const;
export const HERMOD_BRAGI_URD_DATE = ${JSON.stringify(urdDate)} as const;
export const HERMOD_SDK_VERSION = ${JSON.stringify(sdkVersion)} as const;
export const HERMOD_BUILD_AT = ${JSON.stringify(generatedAt)} as const;
export const HERMOD_NODE_BUILD = ${JSON.stringify(nodeVersion)} as const;
`;
}

/**
 * Pipeline complet.
 */
export async function syncBragi({
  hermodRoot = HERMOD_ROOT,
  generatedAt,
} = {}) {
  const hermodPkgPath = resolve(hermodRoot, "package.json");
  const hermodVersion = await readPackageVersion(hermodPkgPath);

  const nodeModulesPath = resolve(hermodRoot, "node_modules");
  const bragiPkgPath = resolve(nodeModulesPath, "@tanfeuille", "bragi", "package.json");
  const sdkPkgPath = resolve(nodeModulesPath, "@anthropic-ai", "sdk", "package.json");

  if (!existsSync(bragiPkgPath)) {
    throw new Error(
      `@tanfeuille/bragi non installé dans node_modules. ` +
        `Lancer : npm install @tanfeuille/bragi OR npm link @tanfeuille/bragi (dev).`,
    );
  }

  if (!existsSync(sdkPkgPath)) {
    throw new Error(`@anthropic-ai/sdk non installé. Lancer : npm install.`);
  }

  const bragiVersion = await readPackageVersion(bragiPkgPath);
  const sdkVersion = await readPackageVersion(sdkPkgPath);

  const bragiRoot = dirname(bragiPkgPath);
  const { urdHash, urdDate } = await readBragiMetadata(bragiRoot);

  const tsContent = generateMetadataContent({
    hermodVersion,
    bragiVersion,
    urdHash,
    urdDate,
    sdkVersion,
    generatedAt,
  });

  const outputPath = resolve(hermodRoot, "src", "metadata.generated.ts");
  let current = null;
  if (existsSync(outputPath)) {
    current = await readFile(outputPath, "utf8");
  }
  const changed = current !== tsContent;

  if (changed) {
    await writeFile(outputPath, tsContent, "utf8");
  }

  return { changed, hermodVersion, bragiVersion, urdHash, urdDate, sdkVersion };
}

async function main() {
  let result;
  try {
    result = await syncBragi();
  } catch (e) {
    console.error(`❌ sync-bragi : ${e.message}`);
    process.exit(1);
  }

  if (!result.changed) {
    console.log(`✓ src/metadata.generated.ts à jour (hermod ${result.hermodVersion}, bragi ${result.bragiVersion}).`);
    process.exit(0);
  }

  console.log(`✓ src/metadata.generated.ts régénéré.`);
  console.log(`  hermod=${result.hermodVersion}, bragi=${result.bragiVersion}, sdk=${result.sdkVersion}`);
  console.log(`  urd_hash=${result.urdHash.slice(0, 8)}…, urd_date=${result.urdDate}`);
  process.exit(0);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  main().catch((e) => {
    console.error(`❌ Erreur inattendue : ${e.message}`);
    if (process.env.HERMOD_DEBUG) console.error(e.stack);
    process.exit(1);
  });
}
