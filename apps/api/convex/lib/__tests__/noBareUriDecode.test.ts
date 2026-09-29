import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source guard: the throwing URI decoder is called only inside
 * `lib/inputGuards.ts` (`safeDecodeURIComponent`). A bare call in an HTTP
 * handler turns a stray `%` in a path segment into a thrown `URIError`, which
 * the handler shells answer with a 500 instead of a 400.
 */
const CONVEX_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = new Set(['lib/inputGuards.ts']);
const SKIPPED_DIRS = new Set(['_generated', '__tests__', 'node_modules']);
const BARE_DECODE = /\bdecodeURIComponent\s*\(/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(path);
		return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('no bare URI decode in convex/', () => {
	it('walks a non-trivial source tree', () => {
		expect(sourceFiles(CONVEX_DIR).length).toBeGreaterThan(100);
	});

	it('calls the throwing decoder only through safeDecodeURIComponent', () => {
		const offenders = sourceFiles(CONVEX_DIR)
			.map((path) => relative(CONVEX_DIR, path).split('\\').join('/'))
			.filter((rel) => !ALLOWED.has(rel))
			.filter((rel) => BARE_DECODE.test(readFileSync(join(CONVEX_DIR, rel), 'utf8')));
		expect(offenders).toEqual([]);
	});
});
