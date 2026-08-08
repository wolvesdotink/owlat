import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Docs-lint for the "Monorepo Structure" tables in the architecture overview —
 * the page a new reader opens first to learn what is in this repository.
 *
 * It listed nine of eighteen packages. Not because nine were once right and the
 * rest arrived unannounced: three whole programs (own-the-mail, the plugin
 * platform, the wire package) each shipped multiple packages, and none of them
 * touched this page, because nothing made them. A table of contents that is
 * half a table of contents is worse than none — a reader concludes the other
 * nine do not exist.
 *
 * So the tables are pinned to the DIRECTORIES, in both directions: a package or
 * app with no row fails, and a row naming a directory that is gone fails too
 * (that is the half that catches a rename, which is the more common event and
 * the one a "did you add a row" reviewer never notices).
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const page = readFileSync(
	resolve(repoRoot, 'apps/docs/content/3.developer/2.architecture.md'),
	'utf8'
);

/** The `apps/x` / `packages/x` directories that actually exist. */
function directories(group: 'apps' | 'packages'): string[] {
	return readdirSync(resolve(repoRoot, group), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => `${group}/${entry.name}`)
		.sort();
}

/**
 * The body of one `### ` subsection: up to the NEXT heading of any level.
 *
 * "Any level" is load-bearing. Stopping only at `## ` swallows the sibling
 * `### ` table below, and then every question about one table is silently
 * answered by both — which is how a check like this passes while documenting
 * nothing.
 */
function subsection(heading: string): string {
	const marker = `### ${heading}\n`;
	const start = page.indexOf(marker);
	expect(start, `the "${heading}" section is gone or renamed`).toBeGreaterThan(-1);
	const bodyStart = start + marker.length;
	const next = page.slice(bodyStart).search(/\n#{1,6} /);
	return next === -1 ? page.slice(bodyStart) : page.slice(bodyStart, bodyStart + next);
}

/** Every row of one table, as `[path, description]`. */
function tableRows(heading: string): [string, string][] {
	const rows = [...subsection(heading).matchAll(/^\| `([^`]+)` \| (.*?) \|$/gm)].map(
		(match) => [match[1]!, match[2]!] as [string, string]
	);
	expect(rows.length, `no rows parsed under "${heading}"`).toBeGreaterThan(1);
	return rows;
}

function tableRowPaths(heading: string): string[] {
	return tableRows(heading)
		.map(([path]) => path)
		.sort();
}

describe('2.architecture.md: the monorepo tables list every directory', () => {
	for (const group of ['apps', 'packages'] as const) {
		const heading = group === 'apps' ? 'Apps' : 'Packages';

		it(`every ${group}/ directory has a row`, () => {
			const missing = directories(group).filter((dir) => !tableRowPaths(heading).includes(dir));
			expect(missing, `undocumented: ${missing.join(', ')}`).toEqual([]);
		});

		it(`every row under "${heading}" names a directory that exists`, () => {
			const stale = tableRowPaths(heading).filter((dir) => !existsSync(resolve(repoRoot, dir)));
			expect(stale, `rows for directories that are gone: ${stale.join(', ')}`).toEqual([]);
		});

		it(`every row under "${heading}" carries a description`, () => {
			// A row added to satisfy the check above and left as `| path |  |`
			// documents nothing. Short is fine; empty or a word is not.
			const thin = tableRows(heading)
				.filter(([, description]) => description.trim().length < 20)
				.map(([path]) => path);
			expect(thin, `no real description: ${thin.join(', ')}`).toEqual([]);
		});
	}

	it('reads a real package list rather than an empty one', () => {
		// Non-triviality: a directory read that returned nothing would agree with
		// an empty table. The floor is what the tree held when the table was
		// completed — eighteen workspace packages plus `sdk-java`, which lives
		// under `packages/` and is outside the workspace globs because it is a
		// Maven project. A nineteenth package raises the floor, it does not fail
		// here; the completeness check above is what asks for its row.
		expect(directories('packages').length).toBeGreaterThanOrEqual(19);
		expect(directories('packages')).toContain('packages/mta-protocol');
	});
});
