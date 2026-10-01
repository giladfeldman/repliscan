import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cached: string | null = null;

/** The version of this library, read from its own package.json (the version a consumer installed). */
export function libraryVersion(): string {
  if (cached) return cached;
  // dist/util/libraryVersion.js and src/util/libraryVersion.ts are both two levels below the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  cached = (JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as { version: string }).version;
  return cached;
}
