import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES, FEATURE_FLAGS } from '@owlat/shared';
import { backtickSpans, docPages, REPO_ROOT } from './repoVocabulary';

/**
 * The four registries a reader ACTS on, checked in both directions.
 *
 * `docsVocabulary.test.ts` answers "does this name exist"; that is enough for
 * prose, but not for the pages that are the interface to a registry. If a
 * feature flag, a CLI command, a provider kind or an environment variable ships
 * without a line on its page, nobody can find it — and the generic checker
 * cannot see an omission, only a wrong name. So each of these four is checked
 * BOTH ways: every registry entry appears on its page, and every entry the page
 * names is in the registry.
 *
 * Deliberately short. The per-page suites this replaces pinned wording, table
 * layout, heading text and paragraph order for a dozen pages; none of that is a
 * contract, and all of it broke on edits that improved the docs.
 */

const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf8');

/** Whole-word, so `SITE_URL` is not satisfied by `ADMIN_SITE_URL`. */
function mentions(page: string, token: string): boolean {
	return new RegExp(`(^|[^A-Za-z0-9_.-])${token.replace(/[.]/g, '\\.')}([^A-Za-z0-9_-]|$)`).test(
		page
	);
}

describe('feature flags', () => {
	const flagIds = Object.keys(FEATURE_FLAGS);
	const pages = [
		'apps/docs/content/en/1.guide/23.feature-flags.md',
		'apps/docs/content/en/3.developer/11.feature-flags.md',
	].map(read);

	it('documents every flag the registry ships', () => {
		const undocumented = flagIds.filter((id) => !pages.some((page) => mentions(page, id)));
		expect(undocumented, 'no feature-flag page names these ids').toEqual([]);
	});

	it('names no flag the registry does not ship', () => {
		// A flag-shaped span: lowercase segments joined by dots, at least two.
		const shaped = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
		const cited = new Set(
			pages.flatMap((page) => backtickSpans(page)).filter((span) => shaped.test(span))
		);
		// Sub-flag prose also cites parent paths and Convex function references;
		// only ids that LOOK like flags and share a first segment with a real flag
		// are held to the registry.
		const namespaces = new Set(flagIds.map((id) => id.split('.')[0]));
		const unknown = [...cited].filter(
			(id) => namespaces.has(id.split('.')[0]!) && !flagIds.includes(id)
		);
		expect(unknown, 'the feature-flag pages name ids the registry does not ship').toEqual([]);
	});
});

describe('owlat CLI commands', () => {
	const page = read('apps/docs/content/en/3.developer/36.setup-cli.md');

	/**
	 * The CLI a reader types is two dispatch tables: the bash wrapper
	 * `scripts/owlat` handles the compose verbs on the host, and everything else
	 * is forwarded to the setup container's `apps/setup-cli` switch.
	 */
	const commands = [
		...new Set([
			...[...read('apps/setup-cli/src/index.ts').matchAll(/^\t{3}case '([a-z][a-z-]*)':$/gm)].map(
				(match) => match[1]!
			),
			...[...read('scripts/owlat').matchAll(/^\t([a-z][a-z-]*(?:\|[\w-]+)*)\)$/gm)]
				.flatMap((match) => match[1]!.split('|'))
				// `help|--help|-h` is the fallback arm, not a command anyone looks up.
				.filter((token) => /^[a-z][a-z-]*$/.test(token) && token !== 'help'),
		]),
	];

	it('parses the dispatch table', () => {
		expect(commands.length, 'no case arms parsed out of setup-cli').toBeGreaterThan(5);
	});

	it('documents every command the CLI dispatches', () => {
		const undocumented = commands.filter((command) => !mentions(page, command));
		expect(undocumented, 'the setup-cli page does not name these commands').toEqual([]);
	});

	it('names no command the CLI does not dispatch', () => {
		const cited = new Set(
			[
				...read('apps/docs/content/en/3.developer/36.setup-cli.md').matchAll(
					/owlat (?:setup )?([a-z][a-z-]{2,})\b/g
				),
			].map((match) => match[1]!)
		);
		// `owlat <command>` also introduces flags and prose verbs; only tokens that
		// are not global options are held to the dispatch table.
		const unknown = [...cited].filter((token) => !commands.includes(token));
		expect(unknown, 'the setup-cli page invokes commands the CLI does not dispatch').toEqual([]);
	});
});

describe('send-provider catalog', () => {
	const kinds = CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind);
	const page = read('apps/docs/content/en/3.developer/15.providers.md');

	it('documents every provider kind the catalog declares', () => {
		expect(kinds.length, 'the catalog is empty').toBeGreaterThan(3);
		const undocumented = kinds.filter((kind) => !mentions(page, kind));
		expect(undocumented, 'the providers page does not name these catalog kinds').toEqual([]);
	});

	it('carries no stale default-provider claim', () => {
		// There is no default: a deployment picks its transport. The page said
		// otherwise for two releases after the catalog stopped having one.
		expect(page).not.toMatch(/default (?:send )?provider is `?[a-z]+`?/i);
	});
});

describe('environment variables', () => {
	const envTs = read('apps/api/convex/lib/env.ts');
	const page = read('apps/docs/content/en/3.developer/8.environment-variables.md');

	/** The `EnvKey` union: every variable the Convex backend reads. */
	const envKeys = (() => {
		const lines = envTs.split('\n');
		const start = lines.findIndex((line) => line.startsWith('export type EnvKey ='));
		expect(start, 'convex/lib/env.ts no longer declares EnvKey').toBeGreaterThan(-1);
		// Comments are stripped FIRST: a quoted token in a comment above a member
		// is not a member, and a `;` in one is not the end of the union.
		const body: string[] = [];
		for (const line of lines.slice(start)) {
			const code = line.replace(/\/\/.*$/, '').trimEnd();
			body.push(code);
			if (code.endsWith(';')) break;
		}
		return [...new Set([...body.join('\n').matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]!))];
	})();

	it('parses the EnvKey union', () => {
		expect(envKeys.length, 'no EnvKey members parsed').toBeGreaterThan(20);
	});

	// The forward direction (every EnvKey is documented) is apps/api's own
	// lint:env-docs gate; this is the direction nothing else checks.
	it('documents no Convex variable the backend does not read', () => {
		const section = page.slice(page.indexOf('## '));
		const documented = new Set(
			[...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| Convex \|/gm)].map((match) => match[1]!)
		);
		expect(documented.size, 'no Convex-scoped rows parsed out of the page').toBeGreaterThan(20);
		const phantom = [...documented].filter((key) => !envKeys.includes(key));
		expect(phantom, 'the page documents Convex variables the backend never reads').toEqual([]);
	});
});

describe('plugin-chapter TypeScript samples', () => {
	/**
	 * Every sample in the plugin chapter is compiled and exercised by
	 * `packages/plugin-kit/src/__tests__/docsSamples.test.ts`, inside a
	 * `// #region <name>` marker. That only holds while the page quotes the
	 * region verbatim — a fence that merely resembles the region, or one written
	 * by hand, is pseudocode that nothing compiles.
	 *
	 * Both directions, and no per-page map: a region must appear somewhere in the
	 * chapter, and a ```ts fence in the chapter must be a region. Shape sketches
	 * that are not compilable TypeScript are tagged ```text instead.
	 */
	const samples = read('packages/plugin-kit/src/__tests__/docsSamples.test.ts');
	const regions = new Map(
		[...samples.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion \1/g)].map((match) => [
			match[1]!,
			match[2]!.trimEnd(),
		])
	);
	const fences = docPages()
		.filter((page) => /\/en\/3\.developer\/4\d\./.test(page.path))
		.flatMap((page) =>
			[
				...readFileSync(resolve(REPO_ROOT, page.path), 'utf8').matchAll(/```ts\n([\s\S]*?)```/g),
			].map((match) => ({ page: page.path, code: match[1]!.trimEnd() }))
		);

	it('parses regions and fences', () => {
		expect(regions.size, 'no #region markers in docsSamples.test.ts').toBeGreaterThan(5);
		expect(fences.length, 'no ```ts fences in the plugin chapter').toBeGreaterThan(5);
	});

	it('quotes every executable sample region verbatim', () => {
		const quoted = new Set(fences.map((fence) => fence.code));
		const unquoted = [...regions].filter(([, code]) => !quoted.has(code)).map(([name]) => name);
		expect(unquoted, 'no plugin page quotes these sample regions verbatim').toEqual([]);
	});

	it('carries no TypeScript fence that is not an executable sample', () => {
		const executable = new Set(regions.values());
		const handWritten = fences
			.filter((fence) => !executable.has(fence.code))
			.map((fence) => `${fence.page}: ${fence.code.split('\n')[0]}…`);
		expect(handWritten, 'these ```ts fences are compiled and run by nothing').toEqual([]);
	});
});

describe('the corpus these invariants read', () => {
	it('still has both locales and a developer chapter', () => {
		const paths = docPages().map((page) => page.path);
		expect(paths.some((path) => path.includes('/en/3.developer/'))).toBe(true);
		expect(paths.some((path) => path.includes('/de/3.developer/'))).toBe(true);
	});
});
