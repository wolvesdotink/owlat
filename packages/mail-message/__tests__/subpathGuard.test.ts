/**
 * Unification decision U3 — the ambiguous `./headers` subpath is RETIRED.
 *
 * After U0 the directional `./parse/headers` and `./compose/headers` subpaths
 * are the only ways in; the old ambiguous `@owlat/mail-message/headers` import
 * (which silently resolved to the parse side) must not survive anywhere in the
 * repo. This guard walks every TypeScript source file and fails if the retired
 * specifier reappears, or if any TypeScript source still names one of the old
 * pre-merge integration branches (those references belong only to the pipeline
 * coordinator, never to shipped code). It is the executable form of the
 * "zero imports of the retired subpath" merge gate.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/mail-message/__tests__ -> repo root is three levels up.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'coverage',
	'.turbo',
	'.next',
	'.nuxt',
	'.output',
]);

const SELF = basename(fileURLToPath(import.meta.url));

function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			out.push(...collectTsFiles(full));
		} else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && entry !== SELF) {
			out.push(full);
		}
	}
	return out;
}

// Built from fragments so this guard file does not itself contain the literal
// tokens it forbids (which would otherwise make the scan self-referential).
const RETIRED_SUBPATH = '@owlat/mail-message' + '/headers';
const OLD_BRANCHES = ['integration/own-the-' + 'inbound', 'integration/own-the-' + 'wire'];

describe('retired ./headers subpath is gone repo-wide (U3)', () => {
	const files = collectTsFiles(repoRoot);

	it('scans a non-trivial set of TypeScript sources', () => {
		expect(files.length).toBeGreaterThan(50);
	});

	it('no source imports the retired @owlat/mail-message/headers subpath', () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			if (source.includes(`${RETIRED_SUBPATH}'`) || source.includes(`${RETIRED_SUBPATH}"`)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('no TypeScript source references the pre-merge integration branch names', () => {
		const offenders: Array<{ file: string; branch: string }> = [];
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			for (const branch of OLD_BRANCHES) {
				if (source.includes(branch)) offenders.push({ file, branch });
			}
		}
		expect(offenders).toEqual([]);
	});
});
