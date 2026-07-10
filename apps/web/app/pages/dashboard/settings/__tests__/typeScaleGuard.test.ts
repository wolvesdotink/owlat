import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Type-scale guard (UX next-layer plan, workstream D — FF adherence).
 *
 * These two settings pages were the worst offenders for arbitrary `text-[Npx]`
 * / `text-[Nrem]` font sizes that bypass the Fluid Functionalism type scale.
 * They were swept onto the named scale (text-2xs / text-caption / text-md and
 * the default text-xs / text-sm steps). This guard keeps them clean so the
 * sweep does not silently regress.
 */

const here = dirname(fileURLToPath(import.meta.url));
const files = {
	system: readFileSync(resolve(here, '../system/index.vue'), 'utf8'),
	operator: readFileSync(resolve(here, '../operator/index.vue'), 'utf8'),
};

// Matches an arbitrary Tailwind font-size utility: text-[13px], text-[0.8125rem]
// (but NOT layout brackets like max-w-[960px], which are prefixed by a word char).
const ARBITRARY_TEXT_SIZE = /(?<![\w-])text-\[[0-9.]+(?:px|rem|em)\]/g;

describe('settings type-scale guard', () => {
	for (const [name, source] of Object.entries(files)) {
		it(`${name}/index.vue uses named FF type-scale steps, not arbitrary text sizes`, () => {
			const offenders = source.match(ARBITRARY_TEXT_SIZE) ?? [];
			expect(offenders).toEqual([]);
		});
	}

	it('the swept pages actually reference the named scale', () => {
		const combined = files.system + files.operator;
		expect(combined).toContain('text-caption');
	});
});
