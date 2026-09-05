import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Type-scale lint for the admin pages: no arbitrary `text-[Npx]` / `text-[Nrem]`
 * font sizes that bypass the named Fluid Functionalism scale (text-2xs /
 * text-caption / text-md and the default steps). The sweep that introduced this
 * covered every page under `pages/dashboard/admin`; the lint holds the tree,
 * not two hand-picked files, so a new page cannot regress it unnoticed.
 */
const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Matches an arbitrary Tailwind font-size utility: text-[13px], text-[0.8125rem]
// (but NOT layout brackets like max-w-[960px], which are prefixed by a word char).
const ARBITRARY_TEXT_SIZE = /(?<![\w-])text-\[[0-9.]+(?:px|rem|em)\]/g;

function vueFilesUnder(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === '__tests__') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) files.push(...vueFilesUnder(full));
		else if (entry.endsWith('.vue')) files.push(full);
	}
	return files;
}

describe('admin type-scale lint', () => {
	const pages = vueFilesUnder(adminRoot);

	it('is reading the admin pages it claims to cover', () => {
		expect(pages.length).toBeGreaterThan(10);
	});

	it('uses named FF type-scale steps, never arbitrary text sizes', () => {
		const offenders = pages.flatMap((file) =>
			(readFileSync(file, 'utf8').match(ARBITRARY_TEXT_SIZE) ?? []).map(
				(hit) => `${relative(adminRoot, file)}: ${hit}`
			)
		);
		expect(offenders).toEqual([]);
	});
});
