#!/usr/bin/env node
/**
 * Documentation-drift gate: the public surface in the CODE must appear in the DOCS.
 *
 *   node scripts/check-docs-coverage.mjs            # surface + versions + quickstart
 *   node scripts/check-docs-coverage.mjs --no-run   # skip building and executing the quickstart
 *
 * Exit 0 = every public token is documented (and the quickstart runs); exit 1 = drift,
 * with every missing item listed. Pinned two-sided by tests/docsCoverageGate.test.ts.
 *
 * The surface is DERIVED from the code with the TypeScript compiler API -- every name
 * exported from src/index.ts, the members of every exported interface / type alias /
 * class (and of the non-exported option types their constructors and functions take),
 * every string-literal value in those types, every parameter name, plus the ids and file
 * names of the bundled spec YAML. There is no hand-kept list here to forget to update: a
 * new export is covered the moment it exists.
 *
 * "Documented" means: appears inside an inline code span or a fenced code block of
 * README.md or any docs/*.md. Prose mentions do not count.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import yaml from 'js-yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// Line endings normalized: a Windows checkout (core.autocrlf) must not hide a fence or heading.
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const QUICKSTART_HEADING = '## Quickstart';
const SPEC_DIR = path.join(SRC, 'discovery', 'spec');

// ------------------------------------------------------------------------------ surface
function nameOf(node) {
  if (!node || !node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function isHidden(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
  if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) {
    return true;
  }
  const n = nameOf(node);
  return n == null || n.startsWith('_') || n.startsWith('#');
}

export function collectSurface() {
  const cfg = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  const entry = path.join(SRC, 'index.ts');
  const program = ts.createProgram([entry], cfg.options);
  const checker = program.getTypeChecker();
  const moduleSym = checker.getSymbolAtLocation(program.getSourceFile(entry));
  if (!moduleSym) throw new Error('could not resolve src/index.ts as a module');

  const surface = {
    export: new Set(),
    member: new Set(),
    value: new Set(),
    parameter: new Set(),
    'spec file': new Set(),
    'spec id': new Set(),
  };
  const visited = new Set();
  const inSrc = (decl) => path.resolve(decl.getSourceFile().fileName).startsWith(SRC);

  // Follow a type reference into a declaration that lives in src/ (exported or not), so the
  // option bags a public constructor or function takes are part of the documented surface.
  function followReference(typeName) {
    let sym = checker.getSymbolAtLocation(typeName);
    if (!sym) return;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    for (const d of sym.declarations ?? []) if (inSrc(d)) walkDeclaration(d);
  }

  function walkParams(params) {
    for (const p of params) {
      if (ts.isIdentifier(p.name)) {
        // One-letter names (`a`, `b`, `s`) are positional; the name carries no API meaning.
        if (!p.name.text.startsWith('_') && p.name.text.length > 1) surface.parameter.add(p.name.text);
      } else {
        for (const el of p.name.elements ?? []) if (el.name && ts.isIdentifier(el.name)) surface.parameter.add(el.name.text);
      }
      if (p.type) walkType(p.type);
    }
  }

  function walkMembers(members) {
    for (const m of members) {
      // Constructors first: they have no name, so isHidden() would drop them.
      if (ts.isConstructorDeclaration(m)) { walkParams(m.parameters); continue; }
      if (isHidden(m)) continue;
      const n = nameOf(m);
      if (n == null) continue;
      if (ts.isIndexSignatureDeclaration(m)) continue;
      surface.member.add(n);
      if (m.parameters) walkParams(m.parameters);
      if (m.type) walkType(m.type);
    }
  }

  function walkType(node) {
    if (!node) return;
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
      surface.value.add(node.literal.text);
      return;
    }
    if (ts.isTypeLiteralNode(node)) { walkMembers(node.members); return; }
    if (ts.isImportTypeNode(node)) {
      // `import('./x.js').T` -- the module path is not API; follow the named type instead.
      if (node.qualifier) followReference(node.qualifier);
      return;
    }
    if (ts.isTypeReferenceNode(node)) {
      followReference(node.typeName);
      for (const a of node.typeArguments ?? []) walkType(a);
      return;
    }
    if (ts.isFunctionTypeNode(node)) { walkParams(node.parameters); walkType(node.type); return; }
    ts.forEachChild(node, (c) => { if (ts.isTypeNode(c)) walkType(c); });
  }

  function walkDeclaration(d) {
    if (visited.has(d)) return;
    visited.add(d);
    if (ts.isFunctionDeclaration(d)) {
      walkParams(d.parameters);
      if (d.type) walkType(d.type);
    } else if (ts.isClassDeclaration(d)) {
      for (const h of d.heritageClauses ?? []) for (const t of h.types) followReference(t.expression);
      walkMembers(d.members);
    } else if (ts.isInterfaceDeclaration(d)) {
      for (const h of d.heritageClauses ?? []) for (const t of h.types) {
        followReference(t.expression);
        for (const a of t.typeArguments ?? []) walkType(a);
      }
      walkMembers(d.members);
    } else if (ts.isTypeAliasDeclaration(d)) {
      walkType(d.type);
    } else if (ts.isVariableDeclaration(d)) {
      if (d.type) walkType(d.type);
    }
  }

  for (const s of checker.getExportsOfModule(moduleSym)) {
    surface.export.add(s.name);
    const r = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    for (const d of r.declarations ?? []) walkDeclaration(d);
  }

  // Bundled spec: the file names a consumer overrides, and the ids that surface in output
  // (matchedKeywords[].id, DiscoveryStats.excludedByPattern keys).
  for (const f of fs.readdirSync(SPEC_DIR).filter((x) => x.endsWith('.yaml'))) {
    surface['spec file'].add(f);
  }
  const kw = yaml.load(fs.readFileSync(path.join(SPEC_DIR, 'search-keywords.yaml'), 'utf8'));
  for (const k of kw.keywords ?? []) surface['spec id'].add(k.id);
  const ex = yaml.load(fs.readFileSync(path.join(SPEC_DIR, 'exclusion-patterns.yaml'), 'utf8'));
  for (const p of ex.patterns ?? []) surface['spec id'].add(p.id);

  return surface;
}

// ------------------------------------------------------------------------------ docs
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
const INLINE_RE = /`([^`\n]+)`/g;

export function docFiles() {
  const out = [path.join(ROOT, 'README.md')];
  const docs = path.join(ROOT, 'docs');
  if (fs.existsSync(docs)) {
    for (const f of fs.readdirSync(docs).sort()) if (f.endsWith('.md')) out.push(path.join(docs, f));
  }
  return out;
}

export function documentedCodeText(files = docFiles()) {
  const chunks = [];
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(FENCE_RE)) chunks.push(m[1]);
    for (const m of text.replace(FENCE_RE, '').matchAll(INLINE_RE)) chunks.push(m[1]);
  }
  return chunks.join('\n');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isDocumented(token, code) {
  return new RegExp(`(?<![\\w$-])${esc(token)}(?![\\w$-])`).test(code);
}

export function findUndocumented(surface, code) {
  const out = [];
  for (const [kind, toks] of Object.entries(surface)) {
    for (const t of toks) if (!isDocumented(t, code)) out.push(`${kind}: ${t}`);
  }
  return out.sort();
}

// ------------------------------------------------------------------------------ versions
export function checkVersions() {
  const problems = [];
  const v = PKG.version;
  const changelog = read(path.join(ROOT, 'CHANGELOG.md'));
  const heads = [...changelog.matchAll(/^## \[?([^\]\s]+)\]?/gm)].map((m) => m[1]);
  const released = heads.filter((h) => h.toLowerCase() !== 'unreleased');
  if (released[0] !== v) problems.push(`changelog: newest entry is ${released[0]}, package.json says ${v}`);
  const cff = path.join(ROOT, 'CITATION.cff');
  const cv = fs.existsSync(cff) ? /^version:\s*"?([0-9][^"\s]*)/m.exec(read(cff)) : null;
  if (!cv) problems.push('citation: no version found in CITATION.cff');
  else if (cv[1] !== v) problems.push(`citation: CITATION.cff says ${cv[1]}, package.json says ${v}`);
  const readme = read(path.join(ROOT, 'README.md'));
  const pins = [...readme.matchAll(new RegExp(`github:giladfeldman/${esc(PKG.name)}#v([0-9][^"'\\s\`]*)`, 'g'))];
  if (pins.length === 0) problems.push('readme: no `github:giladfeldman/<name>#vX.Y.Z` install pin found');
  for (const p of pins) if (p[1] !== v) problems.push(`readme: install pin says v${p[1]}, package.json says ${v}`);
  return problems;
}

// ------------------------------------------------------------------------------ quickstart
export function quickstartBlocks(readme = read(path.join(ROOT, 'README.md'))) {
  const start = readme.indexOf(QUICKSTART_HEADING);
  if (start < 0) throw new Error(`README.md has no '${QUICKSTART_HEADING}' section`);
  const next = readme.indexOf('\n## ', start + QUICKSTART_HEADING.length);
  const body = readme.slice(start, next > 0 ? next : readme.length);
  const blocks = [...body.matchAll(/```(js|javascript|mjs)\n([\s\S]*?)```/g)].map((m) => m[2]);
  if (blocks.length === 0) throw new Error('README quickstart has no ```js block -- nothing would be executed');
  return blocks;
}


export function runQuickstart() {
  const problems = [];
  // One command string (no args array): `npm` is a .cmd shim on Windows and needs a shell.
  const build = spawnSync('npm run build', { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 600000 });
  if (build.status !== 0) return [`build failed (exit ${build.status}):\n${(build.stderr || build.stdout).slice(-1500)}`];
  const blocks = quickstartBlocks();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${PKG.name}-quickstart-`));
  try {
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    // Resolve `import ... from '<package>'` to this working tree exactly as an install would.
    fs.symlinkSync(ROOT, path.join(tmp, 'node_modules', PKG.name), 'junction');
    blocks.forEach((code, i) => {
      const file = path.join(tmp, `quickstart-${i + 1}.mjs`);
      fs.writeFileSync(file, code);
      const r = spawnSync(process.execPath, [file], { cwd: tmp, encoding: 'utf8', timeout: 120000 });
      if (r.status !== 0 || !r.stdout.trim()) {
        problems.push(`quickstart js block ${i + 1} exited ${r.status} with ${r.stdout.length} chars of output:\n${(r.stderr || '').slice(-1500)}`);
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length === 0) console.log(`quickstart: ${blocks.length} js block(s) ran OK against a fresh build`);
  return problems;
}

// ------------------------------------------------------------------------------ main
export function main(argv = process.argv.slice(2)) {
  const surface = collectSurface();
  if (surface.export.size === 0) {
    console.log('FAIL: derived an EMPTY public surface -- the instrument is broken, not the docs clean');
    return 1;
  }
  const code = documentedCodeText();
  const problems = [...findUndocumented(surface, code), ...checkVersions()];
  if (!argv.includes('--no-run')) problems.push(...runQuickstart());
  const n = Object.values(surface).reduce((a, s) => a + s.size, 0);
  if (problems.length) {
    console.log(`FAIL: ${problems.length} documentation problem(s) against ${n} public tokens:`);
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }
  const parts = Object.entries(surface).map(([k, s]) => `${s.size} ${k}`).join(', ');
  console.log(`OK: all ${n} public tokens documented (${parts})`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
