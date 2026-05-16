/**
 * Absolute path to repliscan's bundled spec directory. Pass this to
 * loadSpecKeywords / loadExclusionPatterns / loadRankingWeights when the
 * consumer wants repliscan's default spec rather than its own.
 *
 * Resolves relative to this compiled module: dist/discovery/spec/.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_SPEC_DIR: string = dirname(fileURLToPath(import.meta.url));
