import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Docs-lint for the send-provider authoring guide (the seams plan's P3.4).
 *
 * The guide is the page a third party reads before writing a provider, so every
 * claim on it is a promise the host has to keep — and most of those claims are
 * mechanical: which values a tier may declare, how wide a replay window may be,
 * which field kinds a form may use, which files the scaffold writes. Prose
 * restating a constant is prose that will be wrong the first time the constant
 * moves, and the reader who finds out is an author whose manifest was refused.
 *
 * So every mechanical cell here is pinned to the source that decides it. What is
 * NOT pinned is the guide's judgement — why a capability is refused, what an
 * empty selector list costs — which is the author's to write and a reader's to
 * read. `pluginDocs.test.ts` separately holds this page to the chapter-wide
 * rules (its one `ts` fence is a compiled sample verbatim, its imported names are
 * real exports, and it is reachable from the sidebar).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const guide = read('apps/docs/content/3.developer/49.plugin-send-providers.md');

/** The body of one markdown section, up to the next heading of the same level. */
function section(heading: string): string {
	const start = guide.indexOf(`${heading}\n`);
	expect(start, `the guide has no section "${heading}"`).toBeGreaterThan(-1);
	const level = heading.indexOf(' ');
	const rest = guide.slice(start + heading.length);
	const next = rest.search(new RegExp(`\\n#{1,${level}} `));
	return next === -1 ? rest : rest.slice(0, next);
}

/** The rows of the one markdown table in `body`, as arrays of trimmed cells. */
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

/** Every string member of a union type alias declared in a kit source. */
function unionMembers(source: string, alias: string): string[] {
	const match = new RegExp(`export type ${alias} =([^;]+);`).exec(source);
	expect(match, `the kit no longer declares ${alias}`).not.toBeNull();
	return [...match![1]!.matchAll(/'([a-z-]+)'/g)].map((hit) => hit[1]!);
}

describe('the send-provider guide states the capability vocabulary the kit enforces', () => {
	const sendTransport = read('packages/plugin-kit/src/sendTransport.ts');
	const semantics = section('## Capability semantics');

	/**
	 * The declarable value sets, derived from the kit's own type aliases rather
	 * than copied. These are the two fields whose accepted set is NARROWER at the
	 * plugin tier than in the core catalog, which is exactly the drift an author
	 * reading the core vocabulary would walk into — so a widened union has to
	 * reach this page before it reaches a manifest.
	 */
	it.each([
		['supportsCustomReturnPath', 'PluginSendTransportCustomReturnPathSupport'],
		['messageIdSource', 'PluginSendTransportMessageIdSource'],
	])('lists exactly the values %s accepts', (field, alias) => {
		const row = tableRows(semantics).find((cells) => cells[0] === `\`${field}\``);
		expect(row, `the capability table has no row for ${field}`).toBeDefined();
		const listed = [...row![1]!.matchAll(/`([a-z-]+)`/g)].map((hit) => hit[1]!);
		expect(new Set(listed)).toEqual(new Set(unionMembers(sendTransport, alias)));
	});

	/**
	 * The two DERIVED words, and the two NOT-DECLARABLE ones. Each is a field an
	 * author will look for and not find; the table has to say which of the two
	 * reasons applies, because "derived" means delete the half to lose it and "not
	 * declarable" means it was never yours.
	 */
	it.each([
		['hasProviderFeedback', '*derived*'],
		['domainVerification', '*derived*'],
		['acceptanceSemantics', '*not declarable*'],
		['tagsFeedbackProvenance', '*not declarable*'],
		['setupProbe', '*not declarable*'],
	])('marks %s as %s', (field, marker) => {
		const row = tableRows(semantics).find((cells) => cells[0] === `\`${field}\``);
		expect(row, `the capability table has no row for ${field}`).toBeDefined();
		expect(row![1]).toBe(marker);
		// And the kit's contract must still say so, or the page is describing a
		// restriction that has since been lifted.
		expect(sendTransport, `${field} is no longer named in the contract`).toContain(field);
	});

	it('covers every capability field the transport contract declares', () => {
		// The completeness half: a field added to `PluginSendTransportDefinition`
		// joins the vocabulary an author has to reason about, and an undocumented
		// one is a default nobody chose.
		const definition = sendTransport.slice(
			sendTransport.indexOf('export interface PluginSendTransportDefinition {'),
			sendTransport.indexOf('export const PLUGIN_SEND_TRANSPORT_MAX_ENV_VARS')
		);
		const declared = [...definition.matchAll(/^\treadonly (\w+)\??:/gm)].map((hit) => hit[1]!);
		expect(declared.length).toBeGreaterThan(8);
		// The bundle's structural fields are documented as the bundle, not as
		// capabilities; the rest are capability or configuration declarations.
		const structural = new Set([
			'id',
			'label',
			'module',
			'retryDelays',
			'webhook',
			'domainIdentity',
		]);
		for (const field of declared) {
			if (structural.has(field)) continue;
			expect(guide, `${field} is undocumented on the authoring guide`).toContain(`\`${field}\``);
		}
	});
});

describe('the send-provider guide states the webhook security floor the host enforces', () => {
	const inboundSignature = read('packages/plugin-kit/src/inboundSignature.ts');
	const webhook = section('## Webhook security expectations');

	it('quotes the replay tolerance ceiling the kit enforces', () => {
		const ceiling = /PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS = (\d+);/.exec(
			inboundSignature
		)?.[1];
		expect(ceiling, 'the kit no longer declares a replay tolerance ceiling').toBeTypeOf('string');
		expect(webhook, `the ceiling is no longer ${ceiling}`).toContain(`At most ${ceiling}`);
	});

	it('quotes the signed string the host actually recomputes', () => {
		// The one wire fact a provider integration is implemented against. It is
		// asserted in both places: the kit documents it, and the page states it.
		expect(inboundSignature).toContain('`<timestamp>.<rawBody>`');
		expect(webhook).toContain('`<timestamp>.<rawBody>`');
	});

	it('names the secret namespace fence and the route surface', () => {
		expect(/SECRET_ENV_VAR = \/\^PLUGIN_/.test(inboundSignature)).toBe(true);
		expect(webhook).toContain('`PLUGIN_`-prefixed');
		expect(webhook).toContain('`POST /webhooks/plugin/<pluginId>`');
	});

	it('states the two rules a manifest is refused for', () => {
		// Both are validator refusals, not advice, so the page says "required".
		expect(webhook).toContain('**`signature` is required.**');
		expect(webhook).toContain('**`replay` provisions are required too.**');
	});
});

describe('the send-provider guide states the credential vocabulary a form may use', () => {
	it('names exactly the field kinds a bundled transport may declare', () => {
		const credentials = read('packages/plugin-kit/src/sendTransportCredentials.ts');
		const declaration = credentials.slice(
			credentials.indexOf('PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS = ['),
			credentials.indexOf('] as const;')
		);
		const kinds = [...declaration.matchAll(/'([a-z]+)'/g)].map((hit) => hit[1]!);
		expect(kinds.length).toBeGreaterThan(3);
		const form = section('### The credential form');
		for (const kind of kinds) {
			expect(form, `credential field kind ${kind} is undocumented`).toContain(`\`${kind}\``);
		}
	});
});

describe('the send-provider guide describes the scaffold it tells authors to run', () => {
	const scaffold = read('packages/plugin-cli/src/scaffold.ts');
	const template = read('packages/plugin-cli/src/scaffoldSendProvider.ts');

	it('invokes a template the CLI actually declares', () => {
		const declared = [
			...(/SCAFFOLD_TEMPLATES = \[([^\]]+)\]/.exec(scaffold)?.[1] ?? '').matchAll(/'([a-z-]+)'/g),
		].map((hit) => hit[1]!);
		expect(declared.length).toBeGreaterThan(1);
		expect(declared).toContain('send-provider');
		expect(guide).toContain('--template send-provider');
	});

	/**
	 * THE FILE TABLE, DERIVED. The generator is the authority on what an author
	 * gets, so a half added to (or dropped from) the template must reach this page
	 * before the page can claim to describe the scaffold's output. Both directions
	 * are checked: nothing emitted may be missing from the table, and nothing in
	 * the table may name a file the generator does not write.
	 */
	it('lists exactly the files the send-provider template emits', () => {
		const emitted = [...template.matchAll(/files\.set\('([^']+)'/g)].map((hit) => hit[1]!);
		expect(emitted.length).toBeGreaterThan(8);

		const listed = tableRows(section('## What the scaffold gives you')).map((cells) =>
			cells[0]!.replace(/`/g, '')
		);
		expect(new Set(listed)).toEqual(new Set(emitted));
	});
});

describe('the send-provider guide carries the two-tier provider checklist', () => {
	const checklist = section('## The provider checklist, at both tiers');

	it('gives every numbered step a row with both tiers filled in', () => {
		const rows = tableRows(checklist);
		expect(rows.length).toBeGreaterThan(4);
		rows.forEach((cells, index) => {
			expect(cells[0], 'the checklist steps are no longer numbered in order').toBe(
				String(index + 1)
			);
			// The point of the table is the COMPARISON: a row with one tier blank
			// would read as "that tier has nothing to do here", which is never true.
			expect(cells[1]!.length, `step ${index + 1} has no core-tier entry`).toBeGreaterThan(10);
			expect(cells[2]!.length, `step ${index + 1} has no plugin-tier entry`).toBeGreaterThan(10);
		});
	});

	it('names the single catalog declaration both tiers derive from', () => {
		// D1: one declaration, many derivations. If the catalog moves, an author
		// following step 1 at the core tier edits a file that no longer exists.
		expect(checklist).toContain('packages/shared/src/sendProviderCatalog.ts');
		expect(read('packages/shared/src/sendProviderCatalog.ts').length).toBeGreaterThan(0);
	});

	it('closes the list rather than leaving it open-ended', () => {
		// The claim that makes the checklist worth having: everything NOT on it is
		// a defect, and two ratchets enforce that.
		expect(checklist).toContain('**Nothing else**');
		expect(checklist).toContain('lint:providers');
	});

	/**
	 * THE OTHER CHECKLIST, BOUND TO THIS ONE.
	 *
	 * `/developer/providers` carries the canonical CORE-tier list — the exact file
	 * paths, the compile-time guards, and one step this page's two-tier summary does
	 * not have. Two hand-maintained checklists that disagree are worse than one that
	 * is merely terse: a reader who follows this page and concludes a UI edit means
	 * the contract is broken files a contract bug, while the other page tells them
	 * to write the row.
	 *
	 * So the relationship is asserted rather than trusted: this page's steps are
	 * exactly the REQUIRED steps of the canonical list, and every step the canonical
	 * list marks optional is named here as optional rather than denied. P5.2
	 * restructures `15.providers.md` around this very table; until it does, a
	 * divergence fails here instead of shipping.
	 */
	describe('and defers to the canonical core-tier list rather than contradicting it', () => {
		const core = read('apps/docs/content/3.developer/15.providers.md');
		const heading = '### Send (email) — the provider-N+1 checklist';
		const coreChecklist = (() => {
			const start = core.indexOf(`${heading}\n`);
			expect(start, 'the core providers page no longer carries the N+1 checklist').toBeGreaterThan(
				-1
			);
			const rest = core.slice(start + heading.length);
			const next = rest.search(/\n#{1,3} /);
			return next === -1 ? rest : rest.slice(0, next);
		})();
		/** `| # | Artifact | File(s) | Required? |` — the last cell decides the split. */
		const coreRows = tableRows(coreChecklist);
		const optional = coreRows.filter((cells) => /optional/i.test(cells[3] ?? ''));
		const required = coreRows.filter((cells) => !/optional/i.test(cells[3] ?? ''));

		it('links to it as the canonical list, at an anchor that page still has', () => {
			// The anchor github-slugger derives from the heading above, so a renamed
			// heading fails here rather than shipping a link to nothing.
			expect(checklist).toContain('/developer/providers#send-email--the-provider-n1-checklist');
		});

		it('carries exactly the steps the canonical list marks required', () => {
			expect(required.length).toBeGreaterThan(4);
			expect(tableRows(checklist)).toHaveLength(required.length);
		});

		it('names every optional core step as optional rather than denying it', () => {
			// The sentence under this page's table used to read "no UI edit belongs on
			// that list at either tier", which the canonical list's step 7 contradicts
			// outright. A step the other page calls optional has to be described here
			// as optional — by its number, so a renumbering is caught too.
			expect(optional.length).toBeGreaterThan(0);
			for (const cells of optional) {
				expect(checklist, `core step ${cells[0]} is optional and unmentioned here`).toContain(
					`step ${cells[0]} on the canonical list`
				);
			}
			expect(checklist).toContain('**optionally**');
			expect(checklist).not.toContain('UI or setup-wizard edit belongs');
		});
	});
});
