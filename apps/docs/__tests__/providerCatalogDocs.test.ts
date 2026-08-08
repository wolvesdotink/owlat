import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared/sendProviderCatalog';
import type { SendProviderCatalogEntryShape } from '@owlat/shared/sendProviderCatalog';

/**
 * THE COVERAGE GATE: every provider the catalog declares is documented, and the
 * documented tables never say less than the catalog does (the seams plan's P5.2).
 *
 * Two pages restate the send-provider catalog for two different readers. The
 * providers page names the kinds a developer will look for an adapter folder
 * under; the environment-variables reference is where an OPERATOR looks up what
 * to set before a transport works at all. Both were hand-maintained lists, and
 * both had already drifted: the env reference opened with "Owlat supports four
 * email providers" and offered four `EMAIL_PROVIDER` values while the catalog had
 * declared five for a release, so the one kind a Mailchimp migration arrives on
 * was invisible on the page that tells you how to configure it.
 *
 * The relationship this suite enforces is a SUPERSET, in one direction: the docs
 * may say more than the catalog (SES's SNS variables are read by its feedback
 * path, not by the transport, so the catalog rightly does not gate sending on
 * them) and may never say less. A kind, a required variable or a whole provider
 * that exists in code and not on the page is a failure here.
 *
 * WHY THIS SUITE IMPORTS THE CATALOG WHILE ITS SIBLING PARSES IT.
 * `providerCapabilityDocs` pins the capability TABLE cell by cell and reads the
 * source text through `./catalogSource`, because what it checks is how each field
 * is *declared*. This suite checks declared VALUES — the env-var arrays, the
 * label, the kind order — which the text parser deliberately does not model, so
 * it consumes the module the way every other derivation does. Deriving from the
 * real export is the same discipline the catalog exists to impose (D1); it is
 * also why a variable renamed in the catalog fails here without anyone updating
 * a regex.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const providers = read('apps/docs/content/3.developer/15.providers.md');
const envVars = read('apps/docs/content/3.developer/8.environment-variables.md');

/**
 * The catalog's core entries, under the SHAPE rather than the literal's frozen
 * type: this suite reads the fields every entry has, so widening it to the
 * declared interface is what lets `optionalEnvVars` be read off an entry that
 * does not declare one.
 */
const entries: readonly SendProviderCatalogEntryShape[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;

/** The body of one markdown section, up to the next heading of the same level. */
function section(page: string, heading: string): string {
	const start = page.indexOf(`${heading}\n`);
	expect(start, `the page has no section "${heading}"`).toBeGreaterThan(-1);
	const level = heading.indexOf(' ');
	const rest = page.slice(start + heading.length);
	const next = rest.search(new RegExp(`\\n#{1,${level}} `));
	return next === -1 ? rest : rest.slice(0, next);
}

/** The rows of the first markdown table in `body`, header dropped. */
function tableRows(body: string): string[][] {
	return body
		.split('\n')
		.filter((line) => line.startsWith('|') && !/^\|[\s:-]+\|/.test(line))
		.map((line) =>
			line
				.split('|')
				.slice(1, -1)
				.map((cell) => cell.trim())
		)
		.slice(1);
}

/** Every `` `BACKTICKED` `` token in a cell, in order. */
function codeSpans(cell: string): string[] {
	return [...cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((hit) => hit[1]!);
}

/** The anchor github-slugger derives from a heading's text. */
function slug(headingText: string): string {
	return headingText
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, '')
		.trim()
		.replace(/\s+/g, '-');
}

/** The `EnvKey` union members — the variables the Convex backend may read. */
function envKeys(): Set<string> {
	const source = read('apps/api/convex/lib/env.ts');
	const start = source.indexOf('export type EnvKey =');
	expect(start, 'lib/env.ts no longer declares the EnvKey union').toBeGreaterThan(-1);
	// Comments first, terminator second — several union members carry a prose
	// comment above them, and one of those sentences ends in a semicolon. Cutting
	// at the raw `;` stopped the parse eleven keys in and made this check pass by
	// finding almost nothing; the same order as `check-env-docs.sh`, for the same
	// reason.
	const lines = source
		.slice(start)
		.split('\n')
		.map((line) => line.replace(/\/\/.*/, ''));
	const end = lines.findIndex((line) => /;\s*$/.test(line));
	expect(end, 'the EnvKey union no longer terminates').toBeGreaterThan(0);
	const union = lines.slice(0, end + 1).join('\n');
	const keys = new Set([...union.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((hit) => hit[1]!));
	expect(keys.size, 'the EnvKey parse found almost nothing').toBeGreaterThan(50);
	return keys;
}

/** The provider table on the environment-variables reference. */
const providerSelectionRows = tableRows(section(envVars, '### Provider Selection'));

/**
 * THE GATE ITSELF, as a function of the kinds it is asked about — so the suite
 * below can prove it FAILS, rather than only observing that it passes today.
 *
 * A test that walks the shipped catalog and finds every kind documented says
 * nothing about what happens to the sixth: if the lookup were misspelled, or the
 * table parse returned nothing, the loop would be empty and green. Both callers
 * take their kinds as an argument for that reason, and one case below feeds them
 * a kind no page can possibly document.
 */
function kindsMissingFromEnvReference(kinds: readonly string[]): string[] {
	const documented = new Set(providerSelectionRows.map((cells) => cells[0]));
	return kinds.filter((kind) => !documented.has(`\`${kind}\``));
}

function kindsMissingFromProvidersPage(kinds: readonly string[]): string[] {
	const line = providers.split('\n').find((text) => text.startsWith('**Supported kinds:**'));
	expect(line, 'the providers page no longer lists the supported kinds').toBeDefined();
	const listed = new Set([...line!.matchAll(/`([a-z][a-z0-9]*)`/g)].map((hit) => hit[1]!));
	return kinds.filter((kind) => !listed.has(kind));
}

describe('the environment-variables reference documents every provider the catalog declares', () => {
	it('gives each catalog kind a row, in the catalog order', () => {
		expect(kindsMissingFromEnvReference(entries.map((entry) => entry.kind))).toEqual([]);
		// Order too: the catalog's declaration order is the canonical one every
		// derived list follows, and a reader comparing this table against the
		// transport picker should see the same sequence.
		expect(providerSelectionRows.map((cells) => cells[0])).toEqual(
			entries.map((entry) => `\`${entry.kind}\``)
		);
	});

	it('calls each provider what the catalog calls it', () => {
		for (const [index, entry] of entries.entries()) {
			expect(providerSelectionRows[index]![1], entry.kind).toContain(entry.label);
		}
	});

	it('lists exactly the variables the catalog requires, as the presence gate', () => {
		// EXACTLY, not a superset: this column is the answer to "what must I set
		// before this kind works at all", which is the same list the configured
		// check and fallback eligibility read. A variable listed here that the gate
		// does not read reads as a hard requirement that isn't one; one omitted
		// reads as a working transport that will refuse to send.
		for (const [index, entry] of entries.entries()) {
			expect(codeSpans(providerSelectionRows[index]![2]!), entry.kind).toEqual([
				...entry.requiredEnvVars,
			]);
		}
	});

	it('lists at least the optional variables the catalog declares', () => {
		for (const [index, entry] of entries.entries()) {
			const listed = new Set(codeSpans(providerSelectionRows[index]![3]!));
			for (const variable of entry.optionalEnvVars ?? []) {
				expect(listed, `${entry.kind} / ${variable}`).toContain(variable);
			}
		}
	});

	it('names only variables the backend actually reads', () => {
		// The superset direction has one bound: a page may document more than the
		// catalog gates on, but not a variable nothing reads. `EnvKey` is that
		// bound, and it is the same union `check-env-docs.sh` walks from the other
		// side (every key documented somewhere) — this is the per-provider half it
		// cannot see.
		const known = envKeys();
		for (const cells of providerSelectionRows) {
			for (const variable of [...codeSpans(cells[2]!), ...codeSpans(cells[3]!)]) {
				expect(known, `${cells[0]} names ${variable}, which lib/env.ts does not declare`).toContain(
					variable
				);
			}
		}
	});

	it('sends each row on to a section the page still has', () => {
		const headings = new Set(
			envVars
				.split('\n')
				.filter((line) => line.startsWith('#'))
				.map((line) => slug(line.replace(/^#+\s*/, '')))
		);
		for (const cells of providerSelectionRows) {
			const anchor = /\]\(#([a-z0-9-]+)\)/.exec(cells[4]!)?.[1];
			expect(anchor, `${cells[0]} links to no setup section`).toBeDefined();
			expect(headings, `${cells[0]} links to #${anchor}, which no heading produces`).toContain(
				anchor
			);
		}
	});

	it('never offers an EMAIL_PROVIDER value the catalog does not declare', () => {
		// The inverse of the coverage check: a kind REMOVED from the catalog leaves
		// this page advertising a value that resolves to nothing, which fails closed
		// at dispatch and looks like a broken deployment rather than a stale doc.
		const kinds = new Set(entries.map((entry) => entry.kind));
		const offered = [...envVars.matchAll(/EMAIL_PROVIDER[= ]([a-z][a-z0-9]*)/g)].map(
			(hit) => hit[1]!
		);
		expect(offered.length).toBeGreaterThan(entries.length);
		for (const value of offered) {
			expect(kinds, `the page offers EMAIL_PROVIDER=${value}`).toContain(value);
		}
	});

	it('names every kind in the complete-reference row for EMAIL_PROVIDER', () => {
		// `| \`EMAIL_PROVIDER\` |` also opens the provider table's header row above,
		// so the row wanted is the one in the per-variable reference — the `Convex`
		// column is what tells them apart.
		const row = envVars
			.split('\n')
			.find((line) => line.startsWith('| `EMAIL_PROVIDER` | Convex |'));
		expect(row, 'the complete reference no longer carries an EMAIL_PROVIDER row').toBeDefined();
		for (const entry of entries) {
			expect(row!, `the reference row omits ${entry.kind}`).toContain(`\`${entry.kind}\``);
		}
	});
});

describe('the providers page documents every provider the catalog declares', () => {
	it('lists every catalog kind as a supported kind, in the catalog order', () => {
		expect(kindsMissingFromProvidersPage(entries.map((entry) => entry.kind))).toEqual([]);
		const line = providers.split('\n').find((text) => text.startsWith('**Supported kinds:**'))!;
		expect([...line.matchAll(/`([a-z][a-z0-9]*)`/g)].map((hit) => hit[1]!)).toEqual(
			entries.map((entry) => entry.kind)
		);
	});
});

describe('the coverage gate fails when a provider is undocumented', () => {
	/**
	 * The negative control. `acme` is a kind neither page can be documenting, so a
	 * gate that reports it missing is a gate that would report a real sixth
	 * provider missing too — and one that reports nothing is a green test with no
	 * teeth, which is the failure mode this case exists to rule out.
	 */
	const kinds = [...entries.map((entry) => entry.kind), 'acme'];

	it('reports a catalog kind with no row on the environment-variables reference', () => {
		expect(kindsMissingFromEnvReference(kinds)).toEqual(['acme']);
	});

	it('reports a catalog kind the providers page does not name', () => {
		expect(kindsMissingFromProvidersPage(kinds)).toEqual(['acme']);
	});
});

describe('the provider-N+1 checklist covers both integration tiers', () => {
	const checklist = section(providers, '### Send (email) — the provider-N+1 checklist');
	const rows = tableRows(checklist);

	it('answers every step at both tiers', () => {
		// THE RESTRUCTURE THIS PIECE EXISTS FOR (plan §4). The checklist used to
		// have one column of file paths, with the plugin tier described afterwards
		// in prose — so the reader deciding WHICH tier to ship on had to hold two
		// shapes in their head and take on trust that they matched. A row with one
		// tier blank reads as "that tier has nothing to do here", which is never
		// true of any step on this list.
		expect(rows.length).toBeGreaterThan(4);
		rows.forEach((cells, index) => {
			expect(cells[0], 'the steps are no longer numbered in order').toBe(String(index + 1));
			expect(cells[2]!.length, `step ${index + 1} has no core-tier artifact`).toBeGreaterThan(10);
			expect(cells[4]!.length, `step ${index + 1} has no plugin-tier artifact`).toBeGreaterThan(10);
		});
	});

	it('declares the tiers in its header, core before plugin', () => {
		const header = checklist.split('\n').find((line) => line.startsWith('| # |'));
		expect(header).toBeDefined();
		expect(header!.indexOf('Core kind')).toBeGreaterThan(-1);
		expect(header!.indexOf('Plugin kind')).toBeGreaterThan(header!.indexOf('Core kind'));
	});

	it('sends the plugin tier on to the guide it is written against', () => {
		expect(checklist).toContain('/developer/plugin-send-providers');
		// The page has to exist, or the tier this table now advertises has no
		// contract a reader can follow.
		expect(
			read('apps/docs/content/3.developer/49.plugin-send-providers.md').length
		).toBeGreaterThan(0);
	});

	it('states which tier a new provider should use', () => {
		// D4's policy, in the place someone about to add provider N+1 reads. Without
		// it the two-tier table is a menu with no recommendation, and the default
		// silently stays "core" because that is where the incumbents live.
		expect(checklist).toMatch(/default for provider N\+1/);
	});
});
