/**
 * EVERY SHORTCUT ID A HINT ASKS FOR HAS TO BE IN THE CATALOG.
 *
 * A hint names its key by catalog id (`<UiShortcut id="…">`, a palette row's
 * `shortcutId`, `labelFor('…')`), and an id the catalog does not know renders
 * no hint at all rather than failing. That is the right behaviour for an id a
 * preset unbound, and the wrong one for a typo: the hint just disappears.
 *
 * A SOURCE scan, like the other `*.lint.test.ts` guards. The counter-check at
 * the bottom fails if the scan stops finding ids, which is how a broken walk or
 * regex would otherwise pass silently.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '__tests__', '.nuxt', '.output', 'dist']);

/** The ways a hint names a catalog id with a string literal. */
const PATTERNS = [
	/<UiShortcut\b[^>]*?(?<![:\w-])id="([\w.]+)"/g,
	/\bshortcutId:\s*'([\w.]+)'/g,
	/\b(?:labelFor|ariaFor)\(\s*'([\w.]+)'/g,
];

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
		else if (entry.endsWith('.vue') || entry.endsWith('.ts')) found.push(path);
	}
	return found;
}

function usages(): Array<{ file: string; id: string }> {
	const found: Array<{ file: string; id: string }> = [];
	for (const file of sourceFiles(appRoot)) {
		const source = readFileSync(file, 'utf8');
		for (const pattern of PATTERNS) {
			for (const match of source.matchAll(pattern)) {
				found.push({ file: relative(appRoot, file), id: match[1] as string });
			}
		}
	}
	return found;
}

describe('shortcut ids named by hints', () => {
	const known = new Set(SHORTCUT_CATALOG.map((def) => def.id));
	const all = usages();

	it('all exist in the shortcut catalog', () => {
		expect(all.filter((usage) => !known.has(usage.id))).toEqual([]);
	});

	it('finds the hints it is meant to check', () => {
		expect(all.length).toBeGreaterThan(10);
		expect(all.map((usage) => usage.id)).toEqual(
			expect.arrayContaining(['global.commandPalette', 'postbox.replyAll', 'postbox.archive'])
		);
	});
});
