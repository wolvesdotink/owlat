import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared/sendProviderCatalog';
import type { SendProviderCatalogEntryShape } from '@owlat/shared/sendProviderCatalog';
import {
	codeSpans,
	columnIndex,
	envVarSpans,
	rowCells,
	section,
	tableHeader,
	tableRows,
} from './markdownDocs';

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
 * may say more than the catalog and may never say less. `SES_SNS_TOPIC_ARN` is
 * the standing example of "more" — it is read by SES's feedback VERIFIER alone
 * (`webhooks/adapters/ses.ts`), never on the send path and never as a signing
 * key, so no catalog field describes it while the reference still has to. (Its
 * neighbour `SES_CONFIGURATION_SET` is not that case and no longer documented as
 * one: the transport reads it on every send, so the entry declares it optional.)
 * A kind, a required variable or a whole provider that exists in code and not on
 * the page is a failure here.
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

const providers = read('apps/docs/content/en/3.developer/15.providers.md');
const envVars = read('apps/docs/content/en/3.developer/8.environment-variables.md');

/**
 * The catalog's core entries, under the SHAPE rather than the literal's frozen
 * type: this suite reads the fields every entry has, so widening it to the
 * declared interface is what lets `optionalEnvVars` be read off an entry that
 * does not declare one.
 */
const entries: readonly SendProviderCatalogEntryShape[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;

// `section`, `tableRows`, `tableHeader`, `columnIndex` and the two code-span
// readers live in `./markdownDocs` — one parser for the three suites that read
// these pages, because two of them parse the SAME table and a parser each is how
// a markdown change fails the wrong suite.

/**
 * The words that name a PROVIDER rather than a condition — the kinds and the
 * words of their labels, off the catalog so a sixth provider needs no edit.
 */
const PROVIDER_WORDS: ReadonlySet<string> = new Set(
	CORE_SEND_PROVIDER_CATALOG_ENTRIES.flatMap((entry) => [
		entry.kind,
		...entry.label
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	])
);

/**
 * Does this text claim something is required WITHOUT saying what for?
 *
 * "Required to enable the feedback loop", "Required for delivery event tracking"
 * and "required whenever the `postbox` flag is on" all name their condition and
 * are fine on an optional variable. A flat "Required." does not, and neither
 * does "Required when using MTA." — "when using MTA" is the provider, not the
 * condition.
 *
 * NAMING THE PROVIDER IS NOT A CONDITION, whichever preposition carries it. The
 * first version of this predicate whitelisted any `for`, so the very sentence it
 * was written against could come back as "Required for the MTA." and stay green.
 * So a conditional clause is read: articles are dropped, and a clause that is
 * nothing but provider words ("for the MTA", "for SES") is no condition at all.
 * A clause that names a PURPOSE keeps its exemption even when a provider's name
 * is in it — "Required for SES event publishing" says what for.
 *
 * `by` is in the alternation for the sentence `MTA_WEBHOOK_SECRET` genuinely
 * needs: it is outside the Convex presence gate and mandatory to `apps/mta`,
 * which reads it through `requiredEnv` and refuses to boot without it. "Required
 * BY the MTA service at startup" is that truth, and the clause is judged like any
 * other — "by SES." is still nothing but a provider name and still fails. What is
 * deliberately NOT here is `when` / `if`: "Required when using MTA" is the exact
 * phrasing this gate was written against, and its clause ("using MTA") carries a
 * non-provider word, so admitting the preposition would re-admit the sentence.
 */
function unconditionalRequirement(text: string): boolean {
	for (const hit of text.matchAll(/\brequired\b(?:\s+(to|for|by|whenever)\b([^.|]*))?/gi)) {
		if (!hit[1]) return true;
		const words = (hit[2] ?? '')
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word && word !== 'the' && word !== 'a' && word !== 'an');
		if (words.length > 0 && words.every((word) => PROVIDER_WORDS.has(word))) return true;
	}
	return false;
}

/**
 * Everything the page CLAIMS about one variable — the unit the requirement gate
 * judges, so that "anywhere on the page" means it.
 *
 * Two shapes, because the subject is established differently in each. A row that
 * OPENS with the variable is about it whole, sentences included (the shipped
 * offender's "Required when using MTA." lived in a later sentence of such a row,
 * with the variable named only in the first cell). Prose has no such column, so
 * there the SENTENCE is the unit: "The IMAP server does not read
 * `MTA_WEBHOOK_SECRET`. Its only required Convex credential is
 * `CONVEX_ADMIN_KEY`." is two claims about two variables, and reading it as one
 * line would fail this page's most careful sentence.
 */
function claimsAbout(page: string, variable: string): string[] {
	const token = `\`${variable}\``;
	const lines = page.split('\n');
	return [
		...lines.filter((line) => line.startsWith(`| ${token} |`)),
		...lines
			.filter((line) => !line.startsWith('|') && line.includes(token))
			.flatMap((line) => line.split(/(?<=\.)\s+/))
			.filter((sentence) => sentence.includes(token)),
	];
}

/**
 * The anchor github-slugger derives from a heading's text — which Nuxt Content
 * uses, so this has to be its algorithm and not a plausible one: STRIP the
 * disallowed characters, then turn each remaining space into a hyphen. It does
 * NOT collapse runs, and the difference is visible on this very page
 * (`#send-email--the-provider-n1-checklist`, `#routing--health`): a heading like
 * "Custom MTA & postbox" renders as `custom-mta--postbox`, so a predicate that
 * collapsed the run would demand the broken single-hyphen link instead.
 */
function slug(headingText: string): string {
	return headingText
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, '')
		.replace(/ /g, '-');
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
const providerSelection = section(envVars, '### Provider Selection');
const providerSelectionRows = tableRows(providerSelection);

/**
 * Its columns, resolved BY HEADER TEXT. Positional reads are what let a column
 * inserted to the left re-point every assertion at the neighbour's cell while
 * staying green on the rows that happen to agree.
 */
const column = (name: string) => columnIndex(tableHeader(providerSelection), name);
const KIND = column('`EMAIL_PROVIDER`');
const PROVIDER = column('Provider');
const REQUIRED = column('Required');
const OPTIONAL = column('Optional');
const SETUP = column('Setup');

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
	const documented = new Set(providerSelectionRows.map((cells) => cells[KIND]));
	return kinds.filter((kind) => !documented.has(`\`${kind}\``));
}

/**
 * The kinds the "Supported kinds:" line LISTS — the comma-separated run of
 * backticked tokens at its head, not every backticked token on it.
 *
 * The line is no longer only a list: it goes on to explain, in prose, why the
 * relay picker's order differs. Matching the whole line worked by luck — every
 * identifier the prose names happens to carry an uppercase letter or a dot — and
 * the first all-lowercase one added (`own`, `core`, `tier`) would have failed the
 * ORDER assertion below with "kinds out of order", pointing a reader at the
 * catalog when nobody had touched it. Reading the list as a list is the same
 * discipline `columnIndex` applies one file over.
 */
function supportedKinds(line: string): string[] {
	const list = /^\*\*Supported kinds:\*\*((?:\s*`[a-z][a-z0-9]*`,?)+)/.exec(line);
	expect(list, `the supported-kinds line opens with no list of kinds: ${line}`).not.toBeNull();
	return [...list![1]!.matchAll(/`([a-z][a-z0-9]*)`/g)].map((hit) => hit[1]!);
}

function supportedKindsLine(): string {
	const line = providers.split('\n').find((text) => text.startsWith('**Supported kinds:**'));
	expect(line, 'the providers page no longer lists the supported kinds').toBeDefined();
	return line!;
}

function kindsMissingFromProvidersPage(kinds: readonly string[]): string[] {
	const listed = new Set(supportedKinds(supportedKindsLine()));
	return kinds.filter((kind) => !listed.has(kind));
}

describe('the environment-variables reference documents every provider the catalog declares', () => {
	it('gives each catalog kind a row, in the catalog order', () => {
		expect(kindsMissingFromEnvReference(entries.map((entry) => entry.kind))).toEqual([]);
		// Order too: the catalog's declaration order is the canonical one the
		// derived KIND LISTS follow (`SEND_TRANSPORT_KINDS`,
		// `DELIVERY_PROVIDER_KINDS`, and the tables built off them), so a reader
		// comparing this table against the providers page sees one sequence.
		//
		// The relay picker is the one deliberate exception, and this suite does not
		// ask it to agree: `pickerOrderedKinds()`
		// (`apps/web/app/composables/useRelayCredentialDraft.ts`) orders the kinds
		// carrying a `TRANSPORT_PICKER_COPY` row by that table — the order the
		// shipped screens have always shown them in — and appends only the kinds
		// with no row in catalog order. The copy table has a row for every kind
		// today, so it decides the whole sequence. Re-sorting a shipped form is a
		// user-visible change, and a test demanding catalog order there would be
		// asking for exactly that change.
		expect(providerSelectionRows.map((cells) => cells[KIND])).toEqual(
			entries.map((entry) => `\`${entry.kind}\``)
		);
	});

	it('calls each provider what the catalog calls it', () => {
		for (const [index, entry] of entries.entries()) {
			expect(providerSelectionRows[index]![PROVIDER], entry.kind).toContain(entry.label);
		}
	});

	it('lists exactly the variables the catalog requires, as the presence gate', () => {
		// EXACTLY, not a superset: this column is the answer to "what must I set
		// before this kind works at all", which is the same list the configured
		// check and fallback eligibility read. A variable listed here that the gate
		// does not read reads as a hard requirement that isn't one; one omitted
		// reads as a working transport that will refuse to send.
		for (const [index, entry] of entries.entries()) {
			expect(envVarSpans(providerSelectionRows[index]![REQUIRED]!), entry.kind).toEqual([
				...entry.requiredEnvVars,
			]);
		}
	});

	it('lists at least the optional variables the catalog declares', () => {
		for (const [index, entry] of entries.entries()) {
			const listed = new Set(envVarSpans(providerSelectionRows[index]![OPTIONAL]!));
			for (const variable of entry.optionalEnvVars ?? []) {
				expect(listed, `${entry.kind} / ${variable}`).toContain(variable);
			}
		}
	});

	it('never calls an optional variable unconditionally required, anywhere on the page', () => {
		// THE CONTRADICTION THIS CATCHES, which the index table alone could not.
		// `MTA_WEBHOOK_SECRET` sat in the Optional column here and read "Required
		// when using MTA." in the Custom MTA table 160 lines below — so an operator
		// standing the MTA up either issued a secret they did not need or, worse,
		// read the two rows as disagreeing and guessed. The catalog is unambiguous
		// (it declares the variable beside `OUTBOUND_TLS_MODE`, outside the presence
		// gate), so the detail row was the stale one.
		//
		// The rule is CONDITIONAL PHRASING, not silence: an optional variable may
		// well be required *for something* — feedback, postbox, an SNS loop — and
		// saying so is the useful sentence. What it may never do is claim a bare
		// requirement, so every "required" it carries has to name what for.
		const optional = new Set(entries.flatMap((entry) => entry.optionalEnvVars ?? []));
		expect(optional.size).toBeGreaterThan(4);
		for (const variable of optional) {
			for (const claim of claimsAbout(envVars, variable)) {
				expect(
					unconditionalRequirement(claim),
					`${variable} is optional in the catalog, but the page calls it required without saying what for: ${claim}`
				).toBe(false);
			}
		}
	});

	it('would catch the unconditional phrasing it is written against', () => {
		// The negative control: the exact sentence that shipped, and the conditional
		// forms its siblings use. A gate that passed both would be checking nothing.
		expect(unconditionalRequirement('| `X` | Required when using MTA. |')).toBe(true);
		expect(unconditionalRequirement('| `X` | Required. |')).toBe(true);
		// A PROVIDER IS NOT A CONDITION, whichever word introduces it — the escape
		// the first version of this predicate left open.
		expect(unconditionalRequirement('| `X` | Required for the MTA. |')).toBe(true);
		expect(unconditionalRequirement('| `X` | Required for SES. |')).toBe(true);
		expect(unconditionalRequirement('| `X` | Required by SES. |')).toBe(true);
		expect(unconditionalRequirement('| `X` | Required to enable the feedback loop. |')).toBe(false);
		expect(unconditionalRequirement('| `X` | Required for delivery event tracking. |')).toBe(false);
		// The sentence a variable outside the send gate but inside another
		// service's own contract has to be allowed to make.
		expect(unconditionalRequirement('| `X` | Required by the MTA process at startup. |')).toBe(
			false
		);
		// A purpose stays a purpose when a provider's name is inside it.
		expect(unconditionalRequirement('| `X` | Required for SES event publishing. |')).toBe(false);
		expect(unconditionalRequirement('| `X` | Optional. Recommended with feedback. |')).toBe(false);
	});

	it('reads prose claims, not only table rows', () => {
		// The other half of "anywhere on the page": restating the contradiction in a
		// sentence used to walk straight past this gate, which only ever looked at
		// `| \`VAR\` |` rows.
		expect(
			claimsAbout(
				'| `X` | Fine. |\n\nSetting `X` is optional. `X` is required when using MTA.',
				'X'
			)
		).toEqual(['| `X` | Fine. |', 'Setting `X` is optional.', '`X` is required when using MTA.']);
		// And a sentence is only a claim about the variables IT names: the sentence
		// after "the IMAP server does not read `MTA_WEBHOOK_SECRET`." is about
		// another key entirely, and attributing its "required" to this one would be
		// a false failure on correct prose.
		expect(claimsAbout('The server never reads `X`. Its only required key is `Y`.', 'X')).toEqual([
			'The server never reads `X`.',
		]);
	});

	it('names only variables the backend actually reads', () => {
		// The superset direction has one bound: a page may document more than the
		// catalog gates on, but not a variable nothing reads. `EnvKey` is that
		// bound, and it is the same union `check-env-docs.sh` walks from the other
		// side (every key documented somewhere) — this is the per-provider half it
		// cannot see.
		const known = envKeys();
		for (const cells of providerSelectionRows) {
			for (const variable of [...envVarSpans(cells[REQUIRED]!), ...envVarSpans(cells[OPTIONAL]!)]) {
				expect(
					known,
					`${cells[KIND]} names ${variable}, which lib/env.ts does not declare`
				).toContain(variable);
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
			const anchor = /\]\(#([a-z0-9-]+)\)/.exec(cells[SETUP]!)?.[1];
			expect(anchor, `${cells[KIND]} links to no setup section`).toBeDefined();
			expect(headings, `${cells[KIND]} links to #${anchor}, which no heading produces`).toContain(
				anchor
			);
		}
	});

	it('never offers an EMAIL_PROVIDER value the catalog does not declare', () => {
		// The inverse of the coverage check: a kind REMOVED from the catalog leaves
		// this page advertising a value that resolves to nothing, which fails closed
		// at dispatch and looks like a broken deployment rather than a stale doc.
		//
		// ANCHORED ON THE TWO FORMS THAT REALLY ARE OFFERS — an assignment and a
		// `convex env set` — rather than on "any lowercase word after the variable".
		// The loose version read "set EMAIL_PROVIDER to ses" as offering the value
		// `to` and failed the suite on a correct sentence, which is the kind of
		// false failure that gets a gate loosened rather than a doc fixed.
		const kinds = new Set(entries.map((entry) => entry.kind));
		const offered = [
			...envVars.matchAll(/EMAIL_PROVIDER=([a-z][a-z0-9]*)/g),
			...envVars.matchAll(/env set EMAIL_PROVIDER ([a-z][a-z0-9]*)/g),
		].map((hit) => hit[1]!);
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

	it('carries every catalog-declared variable into the complete reference', () => {
		// The provider-selection table above is the concise setup index. The complete
		// reference is the place an operator expects the per-variable definition, so
		// pin the handoff as well: otherwise both catalog-facing tables can stay green
		// while the supposedly complete table silently drops a newly declared key.
		const completeReference = section(envVars, '## Complete Reference');
		const documented = new Set(
			completeReference
				.split('\n')
				.filter((line) => line.startsWith('| `'))
				.flatMap((line) => envVarSpans(rowCells(line)[0] ?? ''))
		);

		for (const entry of entries) {
			for (const variable of [...entry.requiredEnvVars, ...(entry.optionalEnvVars ?? [])]) {
				expect(documented, `${entry.kind} / ${variable}`).toContain(variable);
			}
		}
	});
});

/**
 * THE SAME TWO CLAIMS, EVERYWHERE THEY ARE MADE.
 *
 * Pinning two pages left the drift alive one page over: seven other pages still
 * called `mta` the default and offered three kinds, so an operator could read
 * "no implicit default — an unset variable refuses sends" on the env reference
 * and "the MTA is the default email provider" on the MTA page, with no way to
 * tell which was current. Both halves were false against the code
 * (`routing.ts` returns `null` when nothing names a provider; the catalog
 * declares five kinds) and the pages that carried them are the ones a
 * self-hoster reads first.
 *
 * So the gate is the tree, not the two files: every markdown page under
 * `apps/docs/content/en` is read, and the two claims are checked wherever they
 * are made. The ENGLISH tree specifically — it is the source every other locale
 * is translated from, and phrase-level assertions against a translation would
 * fail on wording, not on a wrong claim. ADRs included — a decision record that stated a default would be as
 * misleading as any other page, and both of ours already say the opposite.
 */
function contentPages(): { path: string; text: string }[] {
	const pages: { path: string; text: string }[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
			if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
			else if (entry.name.endsWith('.md'))
				pages.push({ path: `${dir}/${entry.name}`, text: read(`${dir}/${entry.name}`) });
		}
	};
	walk('apps/docs/content/en');
	return pages;
}

/**
 * How far from an `EMAIL_PROVIDER` mention a "default" is still ABOUT it.
 *
 * A window rather than the sentence or the line, because the false positives
 * live at both extremes: one prose line runs a whole paragraph long and pairs a
 * `(default when a browser is available)` with an `EMAIL_PROVIDER` mention two
 * clauses later, while the sentence that says "`.env.selfhost.example` ships
 * `COMPOSE_PROFILES=mta`" legitimately names the variable further along. Sixty
 * characters is about a clause — close enough that the two are one statement.
 */
const DEFAULT_CLAIM_WINDOW = 60;

/** Everywhere a page claims `EMAIL_PROVIDER` has a default, denials excluded. */
function defaultClaims(page: string): string[] {
	const claims: string[] = [];
	for (const hit of page.matchAll(/\bdefaults?\b/gi)) {
		const at = hit.index!;
		const before = page.slice(Math.max(0, at - DEFAULT_CLAIM_WINDOW), at);
		const after = page.slice(at, at + DEFAULT_CLAIM_WINDOW);
		if (!`${before}${after}`.includes('EMAIL_PROVIDER')) continue;
		// "there is **no implicit default**", "not an implicit default", "never
		// defaults to" — the sentences that state the truth all deny the word
		// within a few words of it, which is what tells them from a claim.
		if (/\b(no|not|never)\b[^.]{0,30}$/i.test(before)) continue;
		claims.push(`${before}${after}`.replace(/\n/g, ' '));
	}
	return claims;
}

/**
 * Lines declaring the send-provider kind union as a HAND-WRITTEN literal.
 *
 * The third shape of the same drift, and the one the two predicates above cannot
 * see: they read "default" claims and `EMAIL_PROVIDER` table rows, so a fenced
 * `type SendProviderKind = 'mta' | 'ses' | 'resend'` in a code block walked past
 * both while telling a developer to widen a union that is not declared anywhere.
 * It is derived — `CoreSendProviderKind | PluginSendTransportKind`, whose core
 * half is the catalog literal itself — which is the whole content of "there is no
 * 'declare the kind' step".
 */
function literalKindUnions(page: string): string[] {
	return page.split('\n').filter((line) => /type\s+(Core)?SendProviderKind\s*=\s*'/.test(line));
}

/** Table rows that enumerate the `EMAIL_PROVIDER` values a deployment may set. */
function kindEnumerationRows(page: string): string[] {
	return page
		.split('\n')
		.filter(
			(line) =>
				line.startsWith('|') &&
				line.includes('EMAIL_PROVIDER') &&
				[...line.matchAll(/`([a-z][a-z0-9]*)`/g)].filter((hit) =>
					entries.some((entry) => entry.kind === hit[1])
				).length > 1
		);
}

describe('no page in the docs still advertises a default or a short kind list', () => {
	const pages = contentPages();

	it('reads the whole content tree, so the gate cannot pass by finding nothing', () => {
		expect(pages.length).toBeGreaterThan(40);
		expect(pages.filter((page) => page.text.includes('EMAIL_PROVIDER')).length).toBeGreaterThan(8);
	});

	it('never claims `EMAIL_PROVIDER` has a default', () => {
		// `routing.ts` returns `null` when neither a route nor the variable names a
		// provider, and the send entry points refuse before a row is written. A page
		// promising the MTA instead sends an operator looking for a bug in delivery.
		for (const page of pages) {
			expect(defaultClaims(page.text), `${page.path} claims a default`).toEqual([]);
		}
	});

	it('names every catalog kind wherever it enumerates them', () => {
		for (const page of pages) {
			for (const row of kindEnumerationRows(page.text)) {
				for (const entry of entries) {
					expect(row, `${page.path} lists EMAIL_PROVIDER values without ${entry.kind}`).toContain(
						`\`${entry.kind}\``
					);
				}
			}
		}
	});

	it('never gives an EMAIL_PROVIDER row a kind as its default value', () => {
		// The shape a `Default` column takes: no word "default" on the row at all,
		// just `mta` sitting in the column the table's header calls one. It is the
		// same claim, and it survived the check above for years.
		for (const page of pages) {
			for (const row of page.text
				.split('\n')
				.filter((line) => line.startsWith('| `EMAIL_PROVIDER`'))) {
				for (const cell of rowCells(row)) {
					expect(
						entries.some((entry) => cell.replace(/`/g, '') === entry.kind),
						`${page.path} gives EMAIL_PROVIDER the default value ${cell}`
					).toBe(false);
				}
			}
		}
	});

	it('never declares the kind union as a literal', () => {
		for (const page of pages) {
			expect(
				literalKindUnions(page.text),
				`${page.path} writes the kind union out by hand; it is derived from the catalog`
			).toEqual([]);
		}
	});

	it('would catch each claim it is written against', () => {
		// The negative controls: the exact rows and sentences that shipped, beside
		// the corrected forms. Without them a typo in either predicate leaves three
		// green cases that check nothing.
		expect(defaultClaims('| `EMAIL_PROVIDER` | Convex | `mta` (default), `ses` |')).toHaveLength(1);
		expect(
			defaultClaims('The MTA is the **default** email provider (`EMAIL_PROVIDER=mta`).')
		).toHaveLength(1);
		expect(
			defaultClaims('`EMAIL_PROVIDER` names the kind; there is **no implicit default**.')
		).toEqual([]);
		expect(defaultClaims('The default `.env` ships a value nobody reads.')).toEqual([]);
		expect(kindEnumerationRows('| `EMAIL_PROVIDER` | `mta`, `ses`, `resend` |')).toHaveLength(1);
		expect(kindEnumerationRows('Set `EMAIL_PROVIDER` to `ses` or `resend` in prose.')).toEqual([]);
		expect(literalKindUnions("type SendProviderKind = 'mta' | 'ses' | 'resend';")).toHaveLength(1);
		expect(
			literalKindUnions(
				"type SendProviderKind = (typeof CORE_SEND_PROVIDER_CATALOG)[number]['kind'];"
			)
		).toEqual([]);
	});
});

/**
 * The `::callout{…}` blocks on a page, title and body as ONE unit — because a
 * callout's subject lives in its title (`title="\`deduplicatesOnIdempotencyKey\`
 * is half a promise"`) and its claim in the body.
 */
function callouts(page: string): string[] {
	return [...page.matchAll(/::callout\{[^}]*\}\n[\s\S]*?\n::/g)].map((hit) => hit[0]);
}

/**
 * Capabilities the page says the plugin tier cannot declare, out of a list it
 * genuinely can.
 */
function pluginBarredCapabilities(page: string, declarable: readonly string[]): string[] {
	const barred = new Set<string>();
	for (const block of callouts(page)) {
		if (!/cannot declare/i.test(block)) continue;
		const named = new Set(codeSpans(block));
		for (const field of declarable) if (named.has(field)) barred.add(field);
	}
	return [...barred];
}

describe('the providers page documents every provider the catalog declares', () => {
	it('lists every catalog kind as a supported kind, in the catalog order', () => {
		expect(kindsMissingFromProvidersPage(entries.map((entry) => entry.kind))).toEqual([]);
		expect(supportedKinds(supportedKindsLine())).toEqual(entries.map((entry) => entry.kind));
	});

	it('reads the list and not the prose that follows it', () => {
		// The false failure this rules out: an all-lowercase backticked word in the
		// sentence after the list, read as a sixth kind in the wrong position.
		expect(supportedKinds('**Supported kinds:** `mta`, `ses` — `own` is the `mta` tier.')).toEqual([
			'mta',
			'ses',
		]);
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
	const header = tableHeader(checklist);
	const rows = tableRows(checklist);
	const STEP = columnIndex(header, '#');
	const CORE = columnIndex(header, 'Core kind');
	const PLUGIN = columnIndex(header, 'Plugin kind');

	it('answers every step at both tiers', () => {
		// THE RESTRUCTURE THIS PIECE EXISTS FOR (plan §4). The checklist used to
		// have one column of file paths, with the plugin tier described afterwards
		// in prose — so the reader deciding WHICH tier to ship on had to hold two
		// shapes in their head and take on trust that they matched.
		//
		// An EMPTY plugin cell is the failure, not a plugin cell that says there is
		// nothing to do: step 7's honest answer IS "no equivalent step at this
		// tier", because the web override maps are keyed by core kind. What the
		// reader must never get is a blank they have to interpret. So the gate is
		// on CONTENT: every plugin cell either names an artifact (a backticked
		// manifest field, module export or file) or says outright that the tier has
		// no such step — a cell reading "see the guide" fails.
		expect(rows.length).toBeGreaterThan(4);
		rows.forEach((cells, index) => {
			expect(cells[STEP], 'the steps are no longer numbered in order').toBe(String(index + 1));
			expect(cells[CORE]!.length, `step ${index + 1} has no core-tier artifact`).toBeGreaterThan(
				10
			);
			const plugin = cells[PLUGIN]!;
			const answers = codeSpans(plugin).length > 0 || /no equivalent step/i.test(plugin);
			expect(answers, `step ${index + 1}'s plugin cell names no artifact and denies none`).toBe(
				true
			);
		});
	});

	it('declares the tiers in its header, core before plugin', () => {
		expect(PLUGIN).toBeGreaterThan(CORE);
	});

	it('sends the plugin tier on to the guide it is written against', () => {
		expect(checklist).toContain('/developer/plugin-send-providers');
		// The page has to exist, or the tier this table now advertises has no
		// contract a reader can follow.
		expect(
			read('apps/docs/content/en/3.developer/49.plugin-send-providers.md').length
		).toBeGreaterThan(0);
	});

	/**
	 * D4's policy, in the place someone about to add provider N+1 reads. The
	 * PARAGRAPH is the unit, not the section: every field named below also appears
	 * in step 1's list of catalog fields, so a section-wide `toContain` would have
	 * gone on passing with the recommendation itself gutted.
	 */
	const tierChoice = checklist
		.split('\n\n')
		.find((paragraph) => /default for provider N\+1/.test(paragraph));

	it('states which tier a new provider should use', () => {
		// Without it the two-tier table is a menu with no recommendation, and the
		// default silently stays "core" because that is where the incumbents live.
		expect(tierChoice, 'the checklist no longer recommends a tier').toBeTypeOf('string');
	});

	it('names every capability the plugin tier genuinely cannot declare', () => {
		// Get this exception list wrong by one and an author ships on the tier that
		// cannot express the capability their ESP was chosen for — the VERP envelope
		// sender being the expensive one, since losing it costs per-message bounce
		// attribution silently. The kit is the authority: `supportsCustomReturnPath`
		// is narrowed to a single literal there, and the custody fields plus
		// `setupProbe` are refused in the contract's own "WHAT A PLUGIN STILL CANNOT
		// DECLARE" note.
		const kit = read('packages/plugin-kit/src/sendTransport.ts');
		const returnPath = /export type PluginSendTransportCustomReturnPathSupport =([^;]+);/.exec(kit);
		expect(returnPath, 'the kit no longer narrows supportsCustomReturnPath').not.toBeNull();
		expect(
			[...returnPath![1]!.matchAll(/'([a-z-]+)'/g)].map((hit) => hit[1]!),
			'the plugin tier can declare more than `no` now — the recommendation has to say so'
		).toEqual(['no']);
		for (const field of ['supportsCustomReturnPath', 'acceptanceSemantics', 'setupProbe']) {
			expect(tierChoice, `the tier-choice sentence omits \`${field}\``).toContain(`\`${field}\``);
		}
	});

	it('never bars the plugin tier from a capability the kit now lets it declare', () => {
		// THE EXCEPTION LIST HAS A SECOND COPY, and it went stale where the first
		// one did not: the `deduplicatesOnIdempotencyKey` callout still said a
		// bundled transport "cannot declare `true` at all — the plugin tier has no
		// per-send extras contract", written before P3.1 gave that tier
		// `buildSystemMailExtras` and turned the composition-time refusal into a
		// load-time check of the PAIR. An author whose ESP threads an idempotency
		// key read it, believed the plugin tier could not promise dedup, and either
		// shipped on core for nothing or left the declaration off — after which
		// `systemMailRetryDisposition` refuses to re-send an ambiguous password
		// reset that was safe to re-send.
		//
		// So the claim is bound to the contract. A capability the kit accepts as a
		// plain `boolean` has no type standing between an author and the word, and
		// a callout ABOUT that field may not say this tier cannot declare it.
		// Everything else the tier cannot declare is refused by its type — a
		// narrowed union or an absent field — and those callouts are left alone.
		const kit = read('packages/plugin-kit/src/sendTransport.ts');
		const definition = /export interface PluginSendTransportDefinition \{([\s\S]*?)\n\}/.exec(kit);
		expect(definition, 'the kit no longer declares PluginSendTransportDefinition').not.toBeNull();
		const declarable = [...definition![1]!.matchAll(/readonly ([a-zA-Z]+)\?: boolean;/g)].map(
			(hit) => hit[1]!
		);
		expect(declarable, 'P3.1 gave this tier the dedup declaration').toContain(
			'deduplicatesOnIdempotencyKey'
		);
		expect(pluginBarredCapabilities(providers, declarable)).toEqual([]);
		// The negative control: the callout as it read before P3.1 landed, which
		// names its subject in the TITLE and its claim in the body — which is why
		// the unit here is the callout and not the sentence.
		expect(
			pluginBarredCapabilities(
				'::callout{type="warning" title="`deduplicatesOnIdempotencyKey` is half a promise"}\n' +
					'A **bundled plugin** transport cannot declare `true` at all.\n::',
				declarable
			)
		).toEqual(['deduplicatesOnIdempotencyKey']);
	});

	/**
	 * THE PLUGIN COLUMN, BOUND TO THE GUIDE IT SUMMARISES.
	 *
	 * The guide at `/developer/plugin-send-providers` carries the same six steps
	 * with the plugin column canonical, and each page names the other canonical for
	 * its non-primary column. `sendProviderAuthoringDocs` already binds the two by
	 * step COUNT and by the optional step's number — but never by CONTENT, so
	 * changing what a plugin author must export on one page left the other
	 * advertising the old contract with both suites green. That drift costs an
	 * author a missing module export and a composition that fails at first send.
	 */
	it('summarises the same plugin artifacts the guide requires, step for step', () => {
		const guide = read('apps/docs/content/en/3.developer/49.plugin-send-providers.md');
		const guideChecklist = section(guide, '## The provider checklist, at both tiers');
		const guideHeader = tableHeader(guideChecklist);
		const guideStep = columnIndex(guideHeader, '#');
		const guidePlugin = columnIndex(guideHeader, 'Plugin kind');
		const guideRows = tableRows(guideChecklist);
		expect(guideRows.length).toBeGreaterThan(4);

		for (const cells of guideRows) {
			// The artifact each guide row LEADS with — `sendTransports`,
			// `requiredEnvVars`, `module`, `webhook`, `domainIdentity`,
			// `plugins.config.ts`. Renaming one there and not here is the drift.
			const [artifact] = codeSpans(cells[guidePlugin]!);
			expect(artifact, `the guide's step ${cells[guideStep]} names no plugin artifact`).toBeTypeOf(
				'string'
			);
			const mirror = rows.find((row) => row[STEP] === cells[guideStep]);
			expect(mirror, `this page has no step ${cells[guideStep]} to mirror`).toBeDefined();
			expect(
				codeSpans(mirror![PLUGIN]!),
				`step ${cells[guideStep]}'s plugin cell no longer names \`${artifact}\`, which the guide requires`
			).toContain(artifact);
		}
	});
});
