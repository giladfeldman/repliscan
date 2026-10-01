import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FloraDatabase } from './floraLookup.js';

let cached: FloraDatabase | null = null;

/**
 * Load the FReD snapshot bundled with this package (`data/flora-replications.json`,
 * copied next to the compiled code by the build). Read once and cached.
 *
 * The data is the FORRT Replication Database (FReD), CC-BY-4.0 -- credit it wherever
 * results derived from it are shown; the NOTICE file ships with the package.
 */
export function loadBundledFred(): FloraDatabase {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/fred/bundled.js and src/fred/bundled.ts are both two levels below the package
  // root, which holds the build copy under dist/data and the source copy under data.
  for (const candidate of [join(here, '..', 'data', 'flora-replications.json'), join(here, '..', '..', 'data', 'flora-replications.json')]) {
    try {
      cached = JSON.parse(readFileSync(candidate, 'utf-8')) as FloraDatabase;
      return cached;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new Error('repliscan: bundled FReD snapshot (flora-replications.json) not found next to the compiled code');
}
