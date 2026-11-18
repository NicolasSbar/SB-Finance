/**
 * Generador de bundles autocontenidos (.ts) para Supabase Edge Functions.
 *
 * Por qué existe este script:
 * El editor web del Dashboard de Supabase solo sube un único archivo `index.ts` por función:
 * no carga archivos `deno.json` (import maps) ni carpetas externas como `../_shared/`.
 * Este script mantiene la arquitectura modular DRY en `supabase/functions/` y genera
 * archivos autocontenidos listos para copiar y pegar en `supabase/deploy-bundles/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT_DIR, 'supabase', 'functions');
const OUTPUT_DIR = path.join(ROOT_DIR, 'supabase', 'deploy-bundles');

const BARE_IMPORT_MAP = new Map([
  ['@supabase/supabase-js', 'npm:@supabase/supabase-js@2'],
]);

/**
 * Extrae declaraciones `import ... from '...';` (incluso multilínea) y separa
 * los imports relativos (que se inlinean) de los externos (que quedan arriba).
 */
function parseAndStripImports(sourceCode, filePath) {
  const relativeSpecs = [];
  const externalImports = [];

  // Coincide con `import ... from '...';` o `import type ... from '...';` multilínea.
  const importRegex = /^import\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]\s*;?\r?\n?/gm;

  const strippedCode = sourceCode.replace(importRegex, (fullMatch, specifier) => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      relativeSpecs.push(specifier);
      return '';
    }

    const mappedSpecifier = BARE_IMPORT_MAP.get(specifier) ?? specifier;
    const normalizedImport =
      mappedSpecifier === specifier
        ? fullMatch.trimEnd()
        : fullMatch.trimEnd().replace(specifier, mappedSpecifier);
    externalImports.push(normalizedImport);
    return '';
  });

  return {
    relativeSpecs,
    externalImports,
    codeWithoutImports: strippedCode.trim(),
    filePath,
  };
}

/**
 * Quita la palabra clave `export ` al principio de declaraciones cuando un módulo
 * `_shared` se inlinea dentro del mismo archivo `index.ts`.
 */
function stripTopLevelExports(code) {
  return code.replace(
    /^export\s+(?=(?:async\s+function|function|const|let|var|class|interface|type|enum)\b)/gm,
    '',
  );
}

/**
 * Resuelve el grafo de dependencias en orden topológico (dependencias antes que dependientes).
 */
function collectDependencyOrder(entryFile) {
  const visited = new Set();
  const ordered = [];

  function visit(absPath, isEntry) {
    const normalized = path.resolve(absPath);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    const raw = fs.readFileSync(normalized, 'utf8');
    const parsed = parseAndStripImports(raw, normalized);

    for (const relSpec of parsed.relativeSpecs) {
      const targetPath = path.resolve(path.dirname(normalized), relSpec);
      if (!fs.existsSync(targetPath)) {
        throw new Error(`No se encontró el módulo importado "${relSpec}" desde ${normalized}`);
      }
      visit(targetPath, false);
    }

    ordered.push({
      ...parsed,
      isEntry,
    });
  }

  visit(entryFile, true);
  return ordered;
}

function buildBundleForFunction(funcName) {
  const entryFile = path.join(FUNCTIONS_DIR, funcName, 'index.ts');
  if (!fs.existsSync(entryFile)) {
    return null;
  }

  const modules = collectDependencyOrder(entryFile);
  const externalSet = new Set();
  for (const mod of modules) {
    for (const imp of mod.externalImports) {
      externalSet.add(imp);
    }
  }

  const header = [
    '// ============================================================================',
    `// ARCHIVO AUTOGENERADO PARA DEPLOY MANUAL EN SUPABASE EDITOR: ${funcName}`,
    '// NO EDITAR ESTE ARCHIVO DIRECTAMENTE.',
    `// Editá supabase/functions/${funcName}/index.ts o supabase/functions/_shared/*`,
    '// y luego ejecutá: npm run bundle:functions',
    '// ============================================================================',
  ].join('\n');

  const externalBlock = Array.from(externalSet).join('\n');

  const sections = modules.map((mod) => {
    const relFromRoot = path.relative(ROOT_DIR, mod.filePath).replaceAll('\\', '/');
    const body = mod.isEntry ? mod.codeWithoutImports : stripTopLevelExports(mod.codeWithoutImports);
    return [
      `// ----------------------------------------------------------------------------`,
      `// Módulo: ${relFromRoot}`,
      `// ----------------------------------------------------------------------------`,
      body,
    ].join('\n');
  });

  return [header, externalBlock, ...sections].filter(Boolean).join('\n\n') + '\n';
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const entries = fs.readdirSync(FUNCTIONS_DIR, { withFileTypes: true });
  const generated = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_shared' || entry.name.startsWith('.')) {
      continue;
    }

    const bundleContent = buildBundleForFunction(entry.name);
    if (!bundleContent) continue;

    const outPath = path.join(OUTPUT_DIR, `${entry.name}.ts`);
    fs.writeFileSync(outPath, bundleContent, 'utf8');
    const lineCount = bundleContent.split('\n').length;
    generated.push({ name: entry.name, outPath, lineCount });
  }

  for (const item of generated) {
    const relOut = path.relative(ROOT_DIR, item.outPath).replaceAll('\\', '/');
    console.log(`Generado ${relOut} (${item.lineCount} líneas)`);
  }
}

main();
