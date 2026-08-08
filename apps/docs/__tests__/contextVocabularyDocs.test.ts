import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { coreCatalogKinds } from './catalogSource';

/**
 * Docs-lint for the repo-root `CONTEXT.md`, the file that "pins the
 * project-specific language used across architecture decisions".
 *
 * It sits here rather than at the repo root for the same reason
 * `abstractionsDocs.test.ts` does: `apps/docs` is the workspace that already
 * owns doc-consistency suites and already reads repo-relative paths, and a
 * second vitest project rooted at `/` to hold two files would be worse than the
 * import path it saves.
 *
 * Three classes of rot. One of them had already happened; the other two are
 * conventions this file INTRODUCES, and guards from their first use rather than
 * after the first casualty:
 *
 *  1. A COUNTED LIST that a later provider silently invalidated. This one is
 *     history: "Four core adapters today: mta, ses, resend, smtp" shipped, and
 *     stayed after `mandrill` made five. Every counted list in this vocabulary
 *     is now pinned to the array it counts.
 *  2. A CROSS-REFERENCE to a section that does not exist, or that was renamed.
 *     New: before this change the file had no `**§ Section name**` references
 *     at all, so there was nothing to dangle. That spelling is introduced here
 *     precisely BECAUSE it is greppable, and this is what makes it checkable —
 *     a convention nobody can verify decays into prose.
 *  3. An `ADR-NNNN` citation with no document behind it. Also not yet a
 *     casualty: every number the file cited before this change resolved.
 *     `lint:adr` guarantees one document per number, but nothing guaranteed a
 *     citation named a number that exists — and this change adds citations to
 *     an ADR written in the same commit range, which is exactly when a typo or
 *     a renumber (0054 was filed as 0043) goes unnoticed.
 *
 * Everything below is pinned to CODE, never to a second copy of the prose.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function read(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const context = read('CONTEXT.md');

/** Every `## ` heading, in file order. */
const sectionHeadings = [...context.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.trim());

/**
 * The body of one `## ` section: everything up to the next `## ` heading.
 *
 * Sections are addressed BY NAME because that is what a cross-reference names.
 * A section this helper cannot find is a failure rather than an empty string —
 * an assertion against `''` passes for `not.toContain` and fails silently for
 * everything else, which is the exact failure mode the file exists to catch.
 */
function section(name: string): string {
	const heading = `\n## ${name}\n`;
	const start = context.indexOf(heading);
	expect(start, `CONTEXT.md has no "## ${name}" section`).toBeGreaterThan(-1);
	const bodyStart = start + heading.length;
	const next = context.indexOf('\n## ', bodyStart);
	return next === -1 ? context.slice(bodyStart) : context.slice(bodyStart, next);
}

/**
 * String literals of a `const <NAME> = [ … ] as const` array, read from the
 * declaring module. The same trick `abstractionsDocs.test.ts` uses on object
 * registries, for the shape those vocabularies happen to have.
 */
function constArrayLiterals(relativePath: string, declaration: string): string[] {
	const source = read(relativePath);
	const start = source.indexOf(declaration);
	expect(start, `${relativePath} no longer declares ${declaration}`).toBeGreaterThan(-1);
	const body = source.slice(start, source.indexOf(']', start));
	const values = [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
	expect(values.length, `no values parsed out of ${declaration}`).toBeGreaterThan(1);
	return values;
}

/**
 * The file with inline-code spans removed.
 *
 * A cross-reference inside backticks is a QUOTATION of the convention (the note
 * at the top of the file is one), not a reference to a section, and must not be
 * resolved as one.
 */
function prose(text: string): string {
	return text.replace(/`[^`]*`/g, '');
}

/**
 * Every `**§ Section**` reference in a body, by section name.
 *
 * Interior whitespace is COLLAPSED because the file is hand-wrapped at ~80
 * columns and a two-word section name straddles a line break sooner or later.
 * Matching the raw capture would report that wrap as a dangling reference,
 * which trains the next author to either widen the line or delete the check.
 */
function referencesIn(body: string): string[] {
	return [...prose(body).matchAll(/\*\*§ ([^*]+)\*\*/g)].map((match) =>
		match[1]!.replace(/\s+/g, ' ').trim()
	);
}

/**
 * The English word a count is written as in this file's prose. Longer than the
 * catalog can plausibly get, so a count that outgrows it reads `undefined` and
 * fails loudly rather than matching by accident.
 */
const COUNT_WORDS = [
	'Zero',
	'One',
	'Two',
	'Three',
	'Four',
	'Five',
	'Six',
	'Seven',
	'Eight',
	'Nine',
	'Ten',
	'Eleven',
	'Twelve',
	'Thirteen',
	'Fourteen',
	'Fifteen',
	'Sixteen',
	'Seventeen',
	'Eighteen',
	'Nineteen',
	'Twenty',
];

/**
 * Assert that a "N <things>" sentence spells the length of the array it counts.
 *
 * The sentence is located by a regex with the number word as its only capture,
 * so a REWORDING fails here rather than passing vacuously — a counted list this
 * helper can no longer find is the same defect as one that counts wrong.
 *
 * Matched against the body with runs of whitespace collapsed, for the reason
 * `referencesIn` collapses them: the file is hand-wrapped, so any sentence long
 * enough to be worth pinning contains a line break somewhere, and where it
 * falls must not be part of the contract.
 */
function expectCountedWord(body: string, pattern: RegExp, count: number, what: string): void {
	const found = body.replace(/\s+/g, ' ').match(pattern);
	expect(found, `the "${what}" count sentence is gone or reworded`).not.toBeNull();
	const word = COUNT_WORDS[count];
	expect(word, `no English word for ${count}`).toBeDefined();
	expect(found![1]!.toLowerCase(), `${what}: prose says "${found![1]}", code has ${count}`).toBe(
		word!.toLowerCase()
	);
}

describe('CONTEXT.md: section cross-references resolve', () => {
	const references = referencesIn(context);

	it('finds the cross-references it is meant to check', () => {
		// Non-triviality: a regex that matched nothing would agree with every
		// broken reference in the file.
		expect(references.length).toBeGreaterThanOrEqual(5);
	});

	it('every `**§ Section**` reference names a real section', () => {
		const dangling = [...new Set(references)].filter((name) => !sectionHeadings.includes(name));
		expect(dangling, `no "## " heading for: ${dangling.join(', ')}`).toEqual([]);
	});

	it('no section cross-references itself', () => {
		// A self-reference is always a copy-paste, and always sends a reader in a
		// circle rather than to the section that actually holds the answer.
		const selfReferencing = sectionHeadings.filter((name) =>
			referencesIn(section(name)).includes(name)
		);
		expect(selfReferencing).toEqual([]);
	});
});

describe('CONTEXT.md: ADR citations resolve', () => {
	const adrFiles = readdirSync(resolve(repoRoot, 'docs/adr'));
	const cited = [...new Set([...context.matchAll(/ADR-(\d{4})/g)].map((match) => match[1]!))];

	it('finds the citations it is meant to check', () => {
		expect(cited.length).toBeGreaterThan(5);
	});

	it('every cited ADR number has a document', () => {
		const missing = cited.filter((number) => !adrFiles.some((f) => f.startsWith(`${number}-`)));
		expect(missing, `no docs/adr/${missing.join('|')}-*.md`).toEqual([]);
	});
});

describe('CONTEXT.md: the send-provider catalog section is pinned to the catalog', () => {
	/**
	 * The core kinds, read off the catalog's own entries — through the one
	 * parser in `./catalogSource`, which `providerCapabilityDocs.test.ts` reads
	 * too. Not `constArrayLiterals`: that array holds whole entry OBJECTS, so its
	 * string literals are mostly labels, env names and credential-field values,
	 * and telling the kind apart takes the entry-depth anchor that helper owns.
	 */
	const kinds = coreCatalogKinds();

	it('parses mandrill out of the catalog', () => {
		// The kind whose arrival made "four core adapters" false.
		expect(kinds).toContain('mandrill');
		expect(kinds.length).toBeGreaterThanOrEqual(5);
	});

	it('the send-path section names every core kind the catalog declares', () => {
		const providers = section('Send providers');
		const unmentioned = kinds.filter((kind) => !providers.includes(`\`${kind}\``));
		expect(unmentioned, `"Send providers" never names: ${unmentioned.join(', ')}`).toEqual([]);
	});

	it('the send-path section states the adapter count the catalog actually has', () => {
		expectCountedWord(
			section('Send providers'),
			/([A-Z][a-z]+) core adapters today:/,
			kinds.length,
			'core adapters'
		);
	});

	/**
	 * The capability fields, read off the one module that must hold a reader for
	 * each.
	 *
	 * `sendProviderCapabilities.ts` exists so that every optional capability
	 * field on the entry has exactly one fail-closed accessor, so its `…Of`
	 * exports ARE the capability list. Reading the entry TYPE instead would mean
	 * telling capability fields apart from `kind`, `label`, the env names and
	 * the credential array by eye, which is a judgement a test cannot make.
	 */
	function capabilityFields(): string[] {
		const source = read('packages/shared/src/sendProviderCapabilities.ts');
		const fields = [...source.matchAll(/^export function (\w+)Of\(/gm)].map((match) => match[1]!);
		expect(fields.length, 'no capability accessors parsed').toBeGreaterThan(3);
		return fields;
	}

	it('the catalog section names every capability, and counts them right', () => {
		const catalog = section('Send provider catalog');
		const fields = capabilityFields();
		// A capability may be written bare (`hasProviderFeedback`) or with its
		// union inside the same span (`domainVerification: 'api' | 'none'`), so
		// the field name is matched from the opening backtick rather than as a
		// whole span.
		const unmentioned = fields.filter((field) => !catalog.includes(`\`${field}`));
		expect(unmentioned, `capabilities missing: ${unmentioned.join(', ')}`).toEqual([]);
		expectCountedWord(
			catalog,
			/The ([a-z]+) on a catalog entry today:/,
			fields.length,
			'provider capabilities'
		);
	});

	it('the catalog section names every credential field kind the vocabulary declares', () => {
		const catalog = section('Send provider catalog');
		const fieldKinds = constArrayLiterals(
			'packages/shared/src/sendProviderCredentialFields.ts',
			'export const SEND_PROVIDER_CREDENTIAL_FIELD_KINDS = ['
		);
		const unmentioned = fieldKinds.filter((kind) => !catalog.includes(`\`${kind}\``));
		expect(unmentioned, `credential field kinds missing: ${unmentioned.join(', ')}`).toEqual([]);
		expectCountedWord(
			catalog,
			/([A-Z][a-z]+) kinds: `string`/,
			fieldKinds.length,
			'credential field kinds'
		);
	});

	it('the catalog section names every provider tier', () => {
		const catalog = section('Send provider catalog');
		for (const tier of ['own', 'core', 'plugin']) {
			expect(catalog).toContain(`\`${tier}\``);
		}
	});
});

describe('CONTEXT.md: the ramp section is pinned to the deliverability vocabulary', () => {
	const ramp = () => section('Ramp controller and measurement plane');

	const streams = () =>
		constArrayLiterals(
			'packages/shared/src/routingDispatch.ts',
			'export const GOVERNED_MESSAGE_TYPES = ['
		);
	const destinations = () =>
		constArrayLiterals(
			'packages/shared/src/deliverabilityRouting.ts',
			'export const DESTINATION_PROVIDER_KEYS = ['
		);
	const gateKeys = () =>
		constArrayLiterals(
			'apps/api/convex/delivery/signals/types.ts',
			'export const RAMP_GATE_SIGNAL_KEYS = ['
		);

	it('names both axes of a deliverability cell', () => {
		const body = ramp();
		for (const stream of streams()) {
			expect(body, `stream ${stream} unnamed`).toContain(`\`${stream}\``);
		}
		for (const destination of destinations()) {
			expect(body, `destination ${destination} unnamed`).toContain(`\`${destination}\``);
		}
	});

	it('states the grid the two axes actually make', () => {
		// The three numbers in "N streams × M destination providers = N*M cells"
		// are the same rot class as the adapter count: adding a destination
		// provider makes the sentence wrong while every name in it stays right.
		const body = ramp();
		const rows = streams().length;
		const columns = destinations().length;
		expectCountedWord(body, /([A-Z][a-z]+) streams \(/, rows, 'streams');
		expectCountedWord(body, /× ([a-z]+) destination providers/, columns, 'destination providers');
		expectCountedWord(body, /= ([a-z]+) cells/, rows * columns, 'cells');
	});

	/**
	 * The share a cell OPENS at, per stream, read off `RAMP_STREAM_CONFIGS`.
	 *
	 * Sliced per stream rather than scanned flat: the three constants sit in
	 * sibling entries with identical field names, so a flat scan would happily
	 * pair `campaign` with `transactional`'s number.
	 */
	function initialSharePercents(): Map<string, number> {
		const source = read('apps/api/convex/delivery/ramp/gateConfig.ts');
		const start = source.indexOf('export const RAMP_STREAM_CONFIGS');
		expect(start, 'RAMP_STREAM_CONFIGS is gone or renamed').toBeGreaterThan(-1);
		const block = source.slice(start, source.indexOf('\n};', start));
		const marks = [...block.matchAll(/\n\t([a-z]+): \{/g)];
		const percents = new Map<string, number>();
		for (const [index, mark] of marks.entries()) {
			const entry = block.slice(mark.index!, marks[index + 1]?.index ?? block.length);
			const fraction = /initialShareFraction: rateFraction\(([\d.]+)\)/.exec(entry)?.[1];
			expect(fraction, `${mark[1]} declares no initialShareFraction`).toBeDefined();
			// Rounded to a tenth of a point: 0.02 * 100 is not 2 in binary floating
			// point, and the prose is written in whole points.
			percents.set(mark[1]!, Math.round(Number(fraction) * 1000) / 10);
		}
		return percents;
	}

	it('states the share a cell actually opens at, per stream', () => {
		// The one number in this section that is a CONTROL CONSTANT rather than a
		// list length, and the one a reader is most likely to act on: "starts at
		// 0" shipped here while enrolment opens a campaign cell at 2%. Pinned per
		// stream to the config that decides it.
		const body = ramp().replace(/\s+/g, ' ');
		const percents = initialSharePercents();
		expect([...percents.keys()].sort()).toEqual([...streams()].sort());
		for (const [stream, percent] of percents) {
			expect(body, `the opening share for ${stream} is unstated or stale`).toContain(
				`\`${stream}\` ${percent}%`
			);
		}
	});

	it('names every ramp gate the signal registry declares', () => {
		const body = ramp();
		for (const key of gateKeys()) {
			expect(body, `ramp gate ${key} unnamed`).toContain(`\`${key}\``);
		}
	});

	it('states the gate count everywhere the section states it', () => {
		// Three sentences count the gates — the definition, the signal-source
		// entry's "the ramp's own N gates", and the "SPREADS the N" that explains
		// why the registry and the fold cannot disagree. All three are pinned, so
		// a sixth gate cannot be half-documented.
		const body = ramp();
		const count = gateKeys().length;
		expectCountedWord(body, /([A-Z][a-z]+) today, named in the shared signal/, count, 'ramp gates');
		expectCountedWord(body, /the ramp's own ([a-z]+) gates/, count, 'ramp gates (signal source)');
		expectCountedWord(body, /SPREADS the ([a-z]+) from/, count, 'ramp gates (spread)');
	});

	it('states how many provider reputation feeds the registry declares', () => {
		// The feeds the ramp gates do NOT cover: the keys the registry names
		// beside the spread of the gate record.
		const registry = read('apps/api/convex/delivery/signals/registry.ts');
		const start = registry.indexOf('export const SIGNAL_SOURCES');
		expect(start, 'SIGNAL_SOURCES is gone or renamed').toBeGreaterThan(-1);
		const body = registry.slice(start, registry.indexOf('\n};', start));
		const named = [...body.matchAll(/^\t([a-z_]+): /gm)].map((match) => match[1]!);
		expect(named.length, 'no explicitly named signal sources parsed').toBeGreaterThan(0);
		expectCountedWord(
			ramp(),
			/the ([a-z]+) provider reputation feeds/,
			named.length,
			'provider reputation feeds'
		);
	});

	it('names every signal source family', () => {
		const body = ramp();
		for (const kind of constArrayLiterals(
			'apps/api/convex/delivery/signals/types.ts',
			'export const SIGNAL_SOURCE_KINDS = ['
		)) {
			expect(body, `signal family ${kind} unnamed`).toContain(`\`${kind}\``);
		}
	});

	it('cites the ramp ADR rather than restating its argument', () => {
		const body = ramp();
		const cited = body.match(/ADR-(\d{4})/);
		expect(cited, 'the ramp section cites no ADR').not.toBeNull();
		const number = cited![1]!;
		const file = readdirSync(resolve(repoRoot, 'docs/adr')).find((f) => f.startsWith(`${number}-`));
		expect(file, `ADR-${number} has no document`).toBeDefined();
		expect(read(`docs/adr/${file}`)).toMatch(/ramp controller/i);
	});
});

describe('CONTEXT.md: paths named in the new sections exist', () => {
	/**
	 * House style writes a backend path relative to whichever root the sentence
	 * is standing in — `convex/lib/sendProviders/…`, `delivery/ramp/…`, or just
	 * `ramp/degradationMatrix.ts` inside a paragraph about the ramp. So a path
	 * is tried against the repo root and then against each of those roots, and
	 * the assertion is "this file exists somewhere we address code from", which
	 * is the claim a reader actually relies on.
	 *
	 * Only paths are checked — something with a slash plus a file extension or a
	 * trailing slash. Identifiers, unions and env names are not paths.
	 */
	const roots = ['', 'apps/api/', 'apps/api/convex/', 'apps/api/convex/delivery/'];

	function pathsIn(body: string): string[] {
		return [...new Set([...body.matchAll(/`([^`]+)`/g)].map((match) => match[1]!))].filter(
			(value) => /^[\w.@/-]+(\.(ts|vue|md|json)|\/)$/.test(value) && value.includes('/')
		);
	}

	for (const name of ['Send provider catalog', 'Ramp controller and measurement plane']) {
		it(`every file path in "${name}" resolves`, () => {
			const paths = pathsIn(section(name));
			expect(paths.length, `no paths parsed out of "${name}"`).toBeGreaterThan(3);
			const missing = paths.filter(
				(candidate) => !roots.some((root) => existsSync(resolve(repoRoot, root + candidate)))
			);
			expect(missing, `not on disk: ${missing.join(', ')}`).toEqual([]);
		});
	}
});
