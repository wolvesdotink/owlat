/**
 * Gzip sizes of fixture chunks as the bundle scripts measure them.
 *
 * The scripts run under bun and vitest runs under node, and the two zlib
 * builds can compress the same bytes to sizes a byte apart. Expected sizes
 * therefore come from `measure()` in scripts/bundle-closure.ts, run by bun.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const BUNDLE_CLOSURE = resolve(import.meta.dirname, '../bundle-closure.ts');

const MEASURE = `import { measure } from ${JSON.stringify(BUNDLE_CLOSURE)};
const [dir, ...files] = process.argv.slice(1);
console.info(JSON.stringify(Object.fromEntries(files.map((file) => [file, measure(dir, file).gz]))));`;

/** File name → gzip bytes for files in `publicDir`, measured by the scripts' own code. */
export function scriptGzipSizes(publicDir: string, files: string[]): Record<string, number> {
	const result = spawnSync('bun', ['-e', MEASURE, publicDir, ...files], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`measuring gzip sizes failed: ${result.stderr}`);
	return JSON.parse(result.stdout) as Record<string, number>;
}
