// Copies the bundled spec YAML files from src/ into dist/ after the tsc build,
// since tsc only emits .ts -> .js and ignores data files.
import { mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src', 'discovery', 'spec');
const distDir = join(root, 'dist', 'discovery', 'spec');
mkdirSync(distDir, { recursive: true });
for (const f of ['search-keywords.yaml', 'exclusion-patterns.yaml', 'ranking-weights.yaml', 'source-configs.yaml']) {
  copyFileSync(join(srcDir, f), join(distDir, f));
  console.log('copied', f);
}
