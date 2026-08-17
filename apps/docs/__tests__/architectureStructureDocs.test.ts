import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Docs-lint for the "Monorepo Structure" tables in the architecture overview —
 * the page a new reader opens first to learn what is in this repository.
 *
 * It listed ten of the nineteen directories under `packages/`. Not because ten
 * were once right and the rest arrived unannounced: three whole programs
 * (own-the-mail, the plugin platform, the wire package) each shipped multiple
 * packages, and none of them touched this page, because nothing made them. A
 * table of contents that is half a table of contents is worse than none — a
 * reader concludes the other nine do not exist.
 *
 * So the tables are pinned to the DIRECTORIES, in both directions: a package or
 * app with no row fails, and a row naming a directory that is gone fails too
 * (that is the half that catches a rename, which is the more common event and
 * the one a "did you add a row" reviewer never notices).
 *
 * `examples/` is a third group and gets the same treatment. Its members are
 * workspace members like the rest (root `package.json` claims
 * `examples/conformance` and `examples/plugins/*`), and the conformance gallery
 * is the proof that the plugin platform is a real extension point rather than a
 * claim — invisible on the page a new reader opens first, it may as well not
 * exist.
 *
 * THAT ALL THREE GROUPS ARE PINNED IS A DELIBERATE CHOICE, not a side effect,
 * and it has a cost worth naming: a PR adding an app or an example plugin now
 * fails this suite until it adds a row. That is accepted. The gate IS the
 * mechanism — a table nothing enforces is how this page got half-empty in the
 * first place — and a page that pinned one of its three tables would teach a
 * reader to trust all three, which is worse than pinning none.
 *
 * WHEN IT FIRES IS THE SECOND HALF OF THAT COST, and it is not on the offending
 * PR. `scripts/ci-select-affected.sh` selects workspaces with `turbo --affected`;
 * `@owlat/docs` depends on no app, package or example, so a PR that adds
 * `apps/foo` leaves this suite unselected and goes green. The red lands on the
 * next full matrix (push to main, nightly, manual dispatch) — the same latency
 * every repo-root docs-lint here already has (`abstractionsDocs`,
 * `contextVocabularyDocs`), widened by this file from "someone edited a doc" to
 * "someone added a workspace".
 *
 * Closing that gap by declaring the repo-root paths as turbo `inputs` was tried
 * and rejected on measurement: a single `$TURBO_ROOT$` input on ONE task makes
 * `turbo ls --affected` report all 33 workspaces affected for ANY change,
 * including a one-package one — it does not widen this suite's selection, it
 * disables affected-selection for the whole repository. A day of latency on a
 * docs table is the cheaper of the two, so the latency is documented instead of
 * traded for running the full matrix on every PR.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const page = readFileSync(
	resolve(repoRoot, 'apps/docs/content/en/3.developer/2.architecture.md'),
	'utf8'
);

/** The immediate subdirectories of one repo-relative directory, as paths. */
function directories(parent: string): string[] {
	return readdirSync(resolve(repoRoot, parent), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => `${parent}/${entry.name}`)
		.sort();
}

/**
 * The three groups the page tabulates, and how to enumerate each on disk.
 *
 * `examples/` is not a flat directory — the workspace globs are
 * `examples/conformance` plus `examples/plugins/*` — so the group is expressed
 * as its own listing rather than by flattening `examples/` and hoping. A fourth
 * shape (say `examples/tools/*`) would be a new entry here, and until it is one
 * the page is allowed not to mention it.
 */
const GROUPS: readonly { heading: string; members: () => string[] }[] = [
	{ heading: 'Apps', members: () => directories('apps') },
	{ heading: 'Packages', members: () => directories('packages') },
	{
		heading: 'Examples',
		members: () => ['examples/conformance', ...directories('examples/plugins')].sort(),
	},
];

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
	for (const { heading, members } of GROUPS) {
		it(`every directory under "${heading}" has a row`, () => {
			const missing = members().filter((dir) => !tableRowPaths(heading).includes(dir));
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
		// Non-triviality only: a directory read that returned nothing, or a couple
		// of entries, would agree with a table that documents nothing. The floor is
		// deliberately far below today's census (nineteen) rather than pinned to
		// it — deleting a package is a legitimate act this program itself
		// contemplates (`packages/channels`), and a check that went red on it with
		// a message about an empty listing would teach the next author to edit the
		// number, which is the habit this file argues against. The named member
		// carries the real signal.
		expect(directories('packages').length).toBeGreaterThan(5);
		expect(directories('packages')).toContain('packages/mta-protocol');
	});

	it('reads a real example list, gallery included', () => {
		// Same non-triviality, same reasoning about the floor, and one named
		// member: the conformance gallery is the group's reason to be on the page
		// at all, so a listing that lost it while still returning the plugins must
		// fail rather than pass thinner.
		const examples = GROUPS.find((group) => group.heading === 'Examples')!.members();
		expect(examples).toContain('examples/conformance');
		expect(examples.length).toBeGreaterThan(1);
	});
});
