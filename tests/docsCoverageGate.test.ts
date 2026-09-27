/**
 * Two-sided pin for scripts/check-docs-coverage.mjs (the documentation-drift gate).
 *
 * A gate that passes on the real repo proves nothing unless it is also shown to FAIL when
 * the thing it guards is broken -- otherwise an empty derived surface or a regex that
 * matches everything would read as "fully documented". Each planted case must be caught.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const GATE = path.join(ROOT, 'scripts', 'check-docs-coverage.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gate: any;
let surface: Record<string, Set<string>>;
let code: string;

beforeAll(async () => {
  const url: string = pathToFileURL(GATE).href;
  gate = await import(url);
  surface = gate.collectSurface();
  code = gate.documentedCodeText();
}, 60000);

test('the surface is derived from the source, not empty (known-positive control)', () => {
  expect(surface.export.has('runDiscovery')).toBe(true);
  expect(surface.export.has('classifyReplication')).toBe(true);
  expect(surface.member.has('searchScore')).toBe(true);
  expect(surface.member.has('maxPagesPerQuery')).toBe(true); // non-exported ctor option bag
  expect(surface.value.has('needs_more_metadata')).toBe(true);
  expect(surface.parameter.has('maxResults')).toBe(true);
  expect(surface['spec id'].has('BIOLOGICAL')).toBe(true);
  expect(surface['spec file'].has('ranking-weights.yaml')).toBe(true);
  expect(surface.export.size).toBeGreaterThan(100);
});

test('the real repo is fully documented and its versions agree', () => {
  expect(gate.findUndocumented(surface, code)).toEqual([]);
  expect(gate.checkVersions()).toEqual([]);
});

test.each([
  ['export', 'plantedUndocumentedExport'],
  ['member', 'plantedUndocumentedMember'],
  ['value', 'planted_undocumented_value'],
  ['parameter', 'plantedUndocumentedParam'],
  ['spec file', 'planted-undocumented.yaml'],
  ['spec id', 'PLANTED_UNDOCUMENTED_ID'],
])('a planted undocumented %s is reported', (kind, token) => {
  const planted: Record<string, Set<string>> = {};
  for (const [k, v] of Object.entries(surface)) planted[k] = new Set(v);
  planted[kind].add(token);
  expect(gate.findUndocumented(planted, code)).toEqual([`${kind}: ${token}`]);
});

test('a prose mention is not documentation; code spans and fences are', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repliscan-docgate-'));
  try {
    const doc = path.join(tmp, 'doc.md');
    fs.writeFileSync(doc, 'A Widget in prose.\r\n\r\n`Gadget` inline.\r\n\r\n```js\r\nimport { Gizmo } from "x";\r\n```\r\n');
    const c = gate.documentedCodeText([doc]);
    expect(gate.isDocumented('Widget', c)).toBe(false);
    expect(gate.isDocumented('Gadget', c)).toBe(true);
    expect(gate.isDocumented('Gizmo', c)).toBe(true);
    // A prefix must not satisfy a longer name, nor a longer name a prefix.
    expect(gate.isDocumented('Gadge', c)).toBe(false);
    expect(gate.isDocumented('GadgetX', c)).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('end to end: a new undocumented export in src/ fails the gate CLI; the untouched copy passes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repliscan-docgate-e2e-'));
  try {
    for (const f of ['package.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'CITATION.cff']) {
      fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    }
    for (const d of ['src', 'scripts', 'docs']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
    const runGate = () => spawnSync(process.execPath, [path.join(tmp, 'scripts', 'check-docs-coverage.mjs'), '--no-run'],
      { cwd: tmp, encoding: 'utf8', timeout: 120000 });

    const clean = runGate();
    expect(clean.stdout).toMatch(/^OK: all \d+ public tokens documented/m);
    expect(clean.status).toBe(0);

    fs.appendFileSync(path.join(tmp, 'src', 'index.ts'), '\nexport const plantedUndocumentedExport = 1;\n');
    const planted = runGate();
    expect(planted.stdout).toContain('export: plantedUndocumentedExport');
    expect(planted.status).toBe(1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 120000);
