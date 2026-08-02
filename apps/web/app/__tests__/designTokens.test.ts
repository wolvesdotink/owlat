/**
 * A UTILITY CLASS FOR A TOKEN NOBODY DECLARED COMPILES TO NOTHING.
 *
 * Tailwind v4 builds colour utilities from the `--color-*` custom properties in
 * `@owlat/ui`'s `@theme` block, so `bg-surface-subtle` and `text-primary` are
 * not "wrong shade" mistakes — they are class names that produce no CSS at all.
 * They fail SILENTLY: the loading skeleton renders invisible, the state badges
 * lose their background, the link renders as body text, and nothing anywhere
 * says so. The shipped names are `bg-bg-surface` and `text-brand`.
 *
 * The dead names are DERIVED rather than asserted: the first expectation proves
 * the tokens really are undeclared, so this suite goes quiet on its own the day
 * one of them is added to the design system.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CSS_DIR = resolve(REPO_ROOT, 'packages/ui/assets/css');
const SOURCE_ROOTS = [resolve(REPO_ROOT, 'apps/web/app'), resolve(REPO_ROOT, 'packages/ui')];

/** Every `--color-<name>` the design system declares, across both themes. */
function declaredColorTokens(): Set<string> {
	const names = new Set<string>();
	for (const file of readdirSync(CSS_DIR)) {
		if (!file.endsWith('.css')) continue;
		const css = readFileSync(resolve(CSS_DIR, file), 'utf8');
		for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) names.add(match[1] as string);
	}
	return names;
}

function vueFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) found.push(...vueFiles(path));
		else if (entry.name.endsWith('.vue')) found.push(path);
	}
	return found;
}

/** Files whose markup uses a colour utility, ignoring the CSS that defines it. */
function filesUsing(pattern: RegExp): string[] {
	const hits: string[] = [];
	for (const root of SOURCE_ROOTS) {
		for (const file of vueFiles(root)) {
			if (pattern.test(readFileSync(file, 'utf8'))) hits.push(file.slice(REPO_ROOT.length + 1));
		}
	}
	return hits.sort();
}

describe('colour utilities resolve to a declared token', () => {
	const declared = declaredColorTokens();

	it('declares the tokens the delivery surfaces actually paint with', () => {
		expect(declared.has('bg-surface')).toBe(true);
		expect(declared.has('brand')).toBe(true);
	});

	it('paints with no token the design system never declared', () => {
		// The premise: these two produce no CSS, so any use of them is invisible.
		expect(declared.has('surface-subtle')).toBe(false);
		expect(declared.has('primary')).toBe(false);

		expect(filesUsing(/(?<![\w-])bg-surface-subtle(?![\w-])/)).toEqual([]);
		expect(filesUsing(/(?<![\w-])text-primary(?![\w-])/)).toEqual([]);
	});
});
