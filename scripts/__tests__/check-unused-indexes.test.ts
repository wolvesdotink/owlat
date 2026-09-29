/**
 * Conformance for the unused-index ratchet
 * (`apps/api/scripts/check-unused-indexes.sh`).
 *
 * The script prints the declared-but-unqueried `table.index` pairs and hands
 * the comparison with `scripts/unused-index-allowlist.txt` to
 * `scripts/ratchet.sh`. These cases run the REAL script and the REAL ratchet
 * against throwaway trees: both directions of the ratchet, `--write-baseline`,
 * and the non-obvious ways the tree names an index (a listing descriptor's
 * `index:` literal, a search index, a `const foo = defineTable()` binding),
 * so an edit that neuters the extraction is caught.
 */

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { API_ROOT, removeTrees, runGate } from './convexGates.testlib';

const GATE = 'check-unused-indexes.sh';
const ALLOWLIST = 'apps/api/scripts/unused-index-allowlist.txt';
const RATCHET = fileURLToPath(new URL('../ratchet.sh', import.meta.url));

const roots: string[] = [];
afterAll(() => removeTrees(roots));

interface Fixture {
	/** Contents of `convex/schema/tables.ts`. */
	schema: string;
	/** Contents of `convex/queries.ts`, the rest of the backend. */
	code?: string;
	/** Allowlist contents; omitted means no allowlist file at all. */
	allowlist?: string;
}

/** A throwaway repository holding the real gate, the real ratchet and `fixture`. */
async function repo(fixture: Fixture): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-unused-indexes-'));
	roots.push(root);
	const files: Record<string, string> = {
		'apps/api/convex/schema/tables.ts': fixture.schema,
		'apps/api/convex/queries.ts': fixture.code ?? '',
	};
	if (fixture.allowlist !== undefined) files[ALLOWLIST] = fixture.allowlist;
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), contents, 'utf8');
	}
	await mkdir(join(root, 'scripts'), { recursive: true });
	await mkdir(join(root, 'apps/api/scripts'), { recursive: true });
	await copyFile(RATCHET, join(root, 'scripts/ratchet.sh'));
	await copyFile(join(API_ROOT, 'scripts', GATE), join(root, 'apps/api/scripts', GATE));
	return root;
}

const HEADER = '# Convex indexes that check-unused-indexes.sh may find unqueried.\n';

const twoIndexTable = [
	'export const tables = {',
	'\twidgets: defineTable({',
	'\t\townerId: v.string(),',
	'\t})',
	"\t\t.index('by_fixture_owner', ['ownerId'])",
	"\t\t.index('by_fixture_status', ['status']),",
	'};',
	'',
].join('\n');

const queriesOwner =
	"await db.query('widgets').withIndex('by_fixture_owner', (q) => q.eq('ownerId', id));\n";
const queriesBoth = [
	"await db.query('widgets').withIndex('by_fixture_owner', (q) => q.eq('ownerId', id));",
	"await db.query('widgets').withIndex('by_fixture_status', (q) => q.eq('status', 'live'));",
	'',
].join('\n');

describe('check-unused-indexes.sh', () => {
	it('passes when every declared index is queried', async () => {
		const result = await runGate(
			await repo({ schema: twoIndexTable, code: queriesBoth, allowlist: HEADER }),
			GATE
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('0 baseline entries remain');
	});

	it('fails an index declared but never named anywhere as new', async () => {
		const result = await runGate(
			await repo({ schema: twoIndexTable, code: queriesOwner, allowlist: HEADER }),
			GATE
		);
		expect(result.code).toBe(1);
		expect(result.output).toContain('FAIL: 1 Convex index(es) declared but never queried:');
		expect(result.output).toContain('widgets.by_fixture_status');
		expect(result.output).not.toContain('widgets.by_fixture_owner');
	});

	it('prints only the unused pairs under --generate', async () => {
		const result = await runGate(await repo({ schema: twoIndexTable }), GATE, ['--generate']);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('widgets.by_fixture_owner\nwidgets.by_fixture_status\n');
	});

	it('passes an unused index the allowlist names', async () => {
		const result = await runGate(
			await repo({
				schema: twoIndexTable,
				code: queriesOwner,
				allowlist: `${HEADER}# a landing change will query this\nwidgets.by_fixture_status\n`,
			}),
			GATE
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('1 baseline entries remain');
	});

	it('fails a stale allowlist entry whose index is now queried', async () => {
		const result = await runGate(
			await repo({
				schema: twoIndexTable,
				code: queriesBoth,
				allowlist: `${HEADER}widgets.by_fixture_status\n`,
			}),
			GATE
		);
		expect(result.code).toBe(1);
		expect(result.output).toContain(
			`FAIL: 1 stale entr(y/ies) in scripts/unused-index-allowlist.txt:`
		);
		expect(result.output).toContain('now queried, or no longer declared');
	});

	it('fails a stale allowlist entry whose index no longer exists', async () => {
		const result = await runGate(
			await repo({
				schema: twoIndexTable,
				code: queriesBoth,
				allowlist: `${HEADER}widgets.by_fixture_gone\n`,
			}),
			GATE
		);
		expect(result.code).toBe(1);
		expect(result.output).toContain('widgets.by_fixture_gone');
	});

	it('fails a missing allowlist with the seed command', async () => {
		const result = await runGate(await repo({ schema: twoIndexTable, code: queriesBoth }), GATE);
		expect(result.code).toBe(1);
		expect(result.output).toContain('--write-baseline');
	});

	it('re-seeds the allowlist with --write-baseline, keeping its header', async () => {
		const root = await repo({
			schema: twoIndexTable,
			code: queriesOwner,
			allowlist: `${HEADER}widgets.by_fixture_gone\n`,
		});
		const written = await runGate(root, GATE, ['--write-baseline']);
		expect(written.code).toBe(0);
		expect(await readFile(join(root, ALLOWLIST), 'utf8')).toBe(
			`${HEADER}widgets.by_fixture_status\n`
		);
		expect((await runGate(root, GATE)).code).toBe(0);
	});

	it('fails loudly when an index call no longer parses', async () => {
		const wrapped = twoIndexTable.replace(
			"\t\t.index('by_fixture_status', ['status']),",
			"\t\t.index(\n\t\t\t'by_fixture_status',\n\t\t\t['status']\n\t\t),"
		);
		const result = await runGate(
			await repo({ schema: wrapped, code: queriesOwner, allowlist: HEADER }),
			GATE
		);
		expect(result.code).toBe(2);
		expect(result.output).toContain('the schema shape changed');
	});

	// The ADR-0037 listing descriptors hand lib/listing.ts an index name as data;
	// the `.withIndex()` call itself takes a variable, so only the descriptor
	// literal can vouch for the index.
	it('counts a listing descriptor index literal as a reference', async () => {
		const code = [
			'export const widgetListing = {',
			"\ttable: 'widgets',",
			"\tbrowse: { index: 'by_fixture_owner', order: 'desc' },",
			"\tfilters: [{ field: 'status' }],",
			"\tbrowseFilterIndexes: { status: 'by_fixture_status' },",
			'};',
			'',
		].join('\n');
		const result = await runGate(
			await repo({ schema: twoIndexTable, code, allowlist: HEADER }),
			GATE,
			['--generate']
		);
		expect(result.stdout).toBe('');
	});

	it('recognises a search index and its withSearchIndex reference', async () => {
		const schema = [
			'export const tables = {',
			'\twidgets: defineTable({ name: v.string() })',
			"\t\t.searchIndex('search_fixture_widgets', { searchField: 'name' })",
			"\t\t.searchIndex('search_fixture_notes', { searchField: 'notes' }),",
			'};',
			'',
		].join('\n');
		const code =
			"await db.query('widgets').withSearchIndex('search_fixture_widgets', (q) => q.search('name', t));\n";
		const result = await runGate(await repo({ schema, code }), GATE, ['--generate']);
		expect(result.stdout).toBe('widgets.search_fixture_notes\n');
	});

	it('attributes an index to a `const foo = defineTable()` binding', async () => {
		const schema = [
			'const gadgets = defineTable({ ownerId: v.string() })',
			"\t.index('by_fixture_owner', ['ownerId']);",
			'export const tables = { gadgets };',
			'',
		].join('\n');
		const result = await runGate(await repo({ schema }), GATE, ['--generate']);
		expect(result.stdout).toBe('gadgets.by_fixture_owner\n');
	});
});
