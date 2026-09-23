/**
 * EVERY LITERAL MESSAGE KEY THE APP ASKS FOR HAS TO EXIST IN `en`.
 *
 * A key that is missing from the catalog does not throw: vue-i18n renders the
 * key path itself, so the person reads `common.undo` on a button. The catalog
 * parity test (`localeCatalogs.test.ts`) cannot catch it, because both locales
 * agree — the key is simply absent from both.
 *
 * A SOURCE scan, like the other `*.lint.test.ts` guards: it reads every `t('…')`
 * / `$t('…')` call and every static `keypath="…"` whose key is a string
 * literal and checks it against `en.json`. Keys assembled at runtime
 * (template literals, variables) are out of reach by design; the counter-check
 * at the bottom fails if the scan stops finding literals, which is how a broken
 * walk or regex would otherwise pass silently.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '~~/i18n/locales/en.json';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tests stub their own keys; build output is not source. */
const SKIP_DIRS = new Set(['node_modules', '__tests__', '.nuxt', '.output', 'dist']);

/**
 * `t('a.b')`, `$t("a.b")`, `te('a.b')`, `tm('a.b')`, `rt('a.b')`, including a
 * key on the next line. The look-behind keeps `foo.t('…')` and `emit('…')` out.
 */
const CALL = /(?<![\w.$])\$?(?:t|te|tm|rt)\(\s*(['"])([A-Za-z0-9_.-]+)\1/g;
/** `<I18nT keypath="a.b">` — a bound `:keypath` is dynamic and skipped. */
const KEYPATH = /(?<![:\w-])keypath="([A-Za-z0-9_.-]+)"/g;

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

function hasKey(catalog: unknown, key: string): boolean {
	let node: unknown = catalog;
	for (const part of key.split('.')) {
		if (typeof node !== 'object' || node === null || !(part in node)) return false;
		node = (node as Record<string, unknown>)[part];
	}
	return typeof node === 'string' || (typeof node === 'object' && node !== null);
}

interface Usage {
	readonly file: string;
	readonly key: string;
}

function literalKeyUsages(): Usage[] {
	const usages: Usage[] = [];
	for (const file of sourceFiles(appRoot)) {
		const source = readFileSync(file, 'utf8');
		const rel = relative(appRoot, file);
		for (const match of source.matchAll(CALL)) {
			const key = match[2]!;
			// A dot-less literal is not a catalog path (e.g. `t('x')` in a helper).
			if (key.includes('.')) usages.push({ file: rel, key });
		}
		if (file.endsWith('.vue')) {
			for (const match of source.matchAll(KEYPATH)) usages.push({ file: rel, key: match[1]! });
		}
	}
	return usages;
}

describe('literal message keys', () => {
	const usages = literalKeyUsages();

	it('every literal key resolves in en.json', () => {
		const missing = usages
			.filter((usage) => !hasKey(en, usage.key))
			.map((usage) => `${usage.file}: ${usage.key}`);
		expect(missing).toEqual([]);
	});

	it('the scan actually finds literal keys', () => {
		// Thousands in practice; a handful would mean the walk or regex broke.
		expect(usages.length).toBeGreaterThan(1000);
		expect(usages.some((usage) => usage.key === 'dashboard.today.markAllSeen')).toBe(true);
	});
});
