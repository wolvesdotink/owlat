import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '~~/i18n/locales/en.json';

/**
 * A typo in a message key is invisible in review and, thanks to the `en`
 * fallback chain, invisible at runtime too: vue-i18n renders the key path
 * itself, so the page ships with `hero.subtitel` printed where a sentence
 * belongs. Nothing else in the build catches that — `en.json` is valid JSON
 * either way.
 *
 * So: walk every source file under app/, collect the message keys that appear
 * as string literals, and require each one to exist in the source catalog.
 *
 * Keys are recognised by shape — a quoted, dotted path whose first segment is a
 * top-level namespace in en.json. That deliberately covers more than `t('…')`:
 * the section components keep their copy out of the markup in `*Key` fields
 * (`labelKey: 'systemMap.nodes.mta.label'`) and in plain arrays of keys, and
 * those are exactly as typo-prone. Keys assembled at runtime (the mail mock's
 * `` t(`…threads.${thread.id}.sender`) ``) have no literal to match and are not
 * checked here — the catalog parity test is what keeps those honest.
 */

const appDir = fileURLToPath(new URL('..', import.meta.url));
const namespaces = new Set(Object.keys(en));

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourceFiles(path));
		else if (/\.(vue|ts)$/.test(entry.name)) found.push(path);
	}
	return found;
}

function catalogHas(key: string): boolean {
	let node: unknown = en;
	for (const segment of key.split('.')) {
		if (typeof node !== 'object' || node === null) return false;
		node = (node as Record<string, unknown>)[segment];
	}
	return typeof node === 'string';
}

const KEY_LITERAL = /['"]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)['"]/g;

describe('message keys used in the app', () => {
	it('all resolve to a string in en.json', () => {
		const unknown: string[] = [];
		for (const file of sourceFiles(appDir)) {
			const source = readFileSync(file, 'utf8');
			for (const [, key] of source.matchAll(KEY_LITERAL)) {
				if (!namespaces.has(key!.split('.')[0]!)) continue;
				if (!catalogHas(key!)) unknown.push(`${relative(appDir, file)}: ${key}`);
			}
		}
		expect(unknown).toEqual([]);
	});

	it('finds keys at all (the scanner itself still works)', () => {
		const scanned = sourceFiles(appDir)
			.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(KEY_LITERAL)])
			.map(([, key]) => key!)
			.filter((key) => namespaces.has(key.split('.')[0]!));
		expect(new Set(scanned).size).toBeGreaterThan(50);
	});
});
