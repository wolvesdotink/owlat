import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreCatalogEntries } from './catalogSource';
import { rowCells } from './markdownDocs';

/**
 * Docs-lint for the "Declared capabilities" table on the providers page.
 *
 * That table restates the catalog's per-entry declarations cell by cell, and
 * nothing checked it — so it drifted: it still showed `ses` /
 * `supportsCustomReturnPath` as `probe` long after the catalog settled that kind
 * to `no`, which reads as "we probe SES's envelope sender" to anyone deciding
 * whether their VERP stream will work. The correction was easy; noticing it was
 * not. This pins every mechanical cell to the catalog literal so the next stale
 * one fails a test instead of waiting for a reader.
 *
 * Only cells whose value IS the declaration are pinned. `requiredEnvVars` and
 * the `mta` `domainVerification` cell are prose summaries by design ("AWS keys",
 * "own DNS path"), so they stay the author's to write.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const providers = readRepoFile('apps/docs/content/3.developer/15.providers.md');

// The entry parser lives in `./catalogSource` — one anchor and one terminator
// for the two suites that read this literal, because two readers of one fact is
// the defect these suites exist to catch.

function declared(body: string, field: string): string | undefined {
	return new RegExp(`\\n\\t\\t${field}: '([a-z-]+)',`).exec(body)?.[1];
}

/**
 * The cells of one table row, in the column order the header declares — with
 * the leading `|` and the two label columns dropped.
 */
function tableRow(field: string): { columns: string[]; cells: string[] } {
	const lines = providers.split('\n');
	const headerIndex = lines.findIndex((line) => line.startsWith('| Field | Meaning |'));
	expect(headerIndex, 'the declared-capabilities table is gone').toBeGreaterThan(-1);
	// `rowCells` is the shared splitter in `./markdownDocs` — the third copy of it
	// in this directory is what that module removed.
	const row = lines.find((line) => line.startsWith(`| \`${field}\` |`));
	expect(row, `the ${field} row is gone`).toBeDefined();
	return { columns: rowCells(lines[headerIndex]!).slice(2), cells: rowCells(row!).slice(2) };
}

/** `` `probe` → settles `no_envelope_control` `` ⇒ `probe`. */
function leadingValue(cell: string): string {
	return /^`?([a-z][a-z-]*)`?/.exec(cell)?.[1] ?? cell;
}

describe('the providers page restates the send catalog without drifting from it', () => {
	const entries = coreCatalogEntries();

	it('finds the core kinds in the catalog literal', () => {
		expect(entries.map((entry) => entry.kind)).toContain('ses');
		expect(entries.length).toBeGreaterThan(3);
	});

	it('gives the table one column per core kind, in the catalog order', () => {
		const { columns } = tableRow('hasProviderFeedback');
		expect(columns).toEqual(entries.map((entry) => `\`${entry.kind}\``));
	});

	it('has a row for every capability field the catalog declares', () => {
		// THE OMISSION THE CELL CHECKS CANNOT SEE. Every assertion below starts
		// from a field NAME, so a field added to the catalog and not to the table
		// is invisible to all of them — which is exactly what happened when
		// `deduplicatesOnIdempotencyKey` landed: the page went on saying "every
		// catalog entry answers six capability questions" while the answer to the
		// seventh decided whether an ambiguous password reset may be re-sent.
		//
		// Read off the UNION OF EVERY ENTRY, not off one of them. An earlier
		// version read `mta` alone, on the premise that it declares every field —
		// and that premise expired the moment `setupProbe` landed on `resend` and
		// `smtp` and on nothing else, which is exactly the drift this test exists
		// to catch. A field only the relay kinds can answer is still a field the
		// table owes a row.
		//
		// Excused: `kind` and `label` are identity, `retryDelays` is a schedule
		// rather than a capability, and `pluginId` is tier bookkeeping.
		const notCapabilities = new Set(['kind', 'label', 'retryDelays', 'pluginId']);
		const declaredFields = [
			...new Set(
				entries.flatMap((entry) =>
					[...entry.body.matchAll(/\n\t\t([a-zA-Z]+):/g)].map((match) => match[1]!)
				)
			),
		].filter((field) => !notCapabilities.has(field));
		const lines = providers.split('\n');
		expect(
			declaredFields.filter((field) => !lines.some((line) => line.startsWith(`| \`${field}\` |`))),
			'these catalog fields have no row in the Declared capabilities table'
		).toEqual([]);
	});

	it.each([
		// `tier` is pinned like any other single-valued declaration: the row says
		// which entry is `own` and which are `core`, and the own arm is what every
		// ramp gate measures against. A kind shipping as `plugin`, or the `own` tier
		// moving, must not be able to leave this table reading the old answer.
		'tier',
		'supportsCustomReturnPath',
		'domainVerification',
		'acceptanceSemantics',
		'messageIdSource',
	])('%s: every cell leads with the value the catalog declares', (field) => {
		const { cells } = tableRow(field);
		for (const [index, entry] of entries.entries()) {
			const value = declared(entry.body, field);
			expect(value, `${entry.kind} declares no ${field}`).toBeDefined();
			// The `mta` domain-verification cell is prose ("own DNS path"): the
			// kind verifies through our own DNS path rather than a provider API,
			// which `none` states accurately but unhelpfully. Every other cell is
			// the declaration.
			if (field === 'domainVerification' && entry.kind === 'mta') continue;
			expect(leadingValue(cells[index]!), `${entry.kind} / ${field}`).toBe(value);
		}
	});

	it.each(['hasProviderFeedback', 'deduplicatesOnIdempotencyKey', 'tagsFeedbackProvenance'])(
		'%s: yes/no matches the declared boolean',
		(field) => {
			const { cells } = tableRow(field);
			for (const [index, entry] of entries.entries()) {
				const value = new RegExp(`\\n\\t\\t${field}: (true|false),`).exec(entry.body)?.[1];
				expect(value, `${entry.kind} declares no ${field}`).toBeDefined();
				expect(cells[index], `${entry.kind} / ${field}`).toBe(value === 'true' ? 'yes' : 'no');
			}
		}
	);
});
