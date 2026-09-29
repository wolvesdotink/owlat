/**
 * Ratchet: every Postbox page carries the `postboxPageTransition` middleware,
 * so moving between two Postbox pages swaps instantly (plan Q5: no page
 * transition inside the Postbox). A new page without it would fade in and out
 * again on every visit from another Postbox page.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const postboxPagesRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function vueFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === '__tests__' ? [] : vueFiles(path);
		return name.endsWith('.vue') ? [path] : [];
	});
}

const pages = vueFiles(postboxPagesRoot).map((path) => ({
	page: relative(postboxPagesRoot, path),
	source: readFileSync(path, 'utf8'),
}));

describe('Postbox pages swap without a page transition', () => {
	it('finds the Postbox pages', () => {
		// A broken walk would pass every assertion below vacuously.
		expect(pages.map(({ page }) => page)).toEqual(
			expect.arrayContaining(['index.vue', 'search.vue', join('[folder]', '[[messageId]].vue')])
		);
	});

	it.each(pages.map(({ page, source }) => [page, source]))(
		'%s runs the postboxPageTransition middleware',
		(_page, source) => {
			expect(source).toMatch(/middleware:\s*\['auth',\s*postboxPageTransition\]/);
		}
	);
});
