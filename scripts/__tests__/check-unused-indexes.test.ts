/**
 * Conformance for the unused-index gate
 * (`apps/api/scripts/check-unused-indexes.sh`).
 *
 * The script prints the declared-but-unqueried `table.index` pairs and hands
 * them to `scripts/ratchet.sh --zero`, which fails on any of them: there is no
 * allowlist. These cases run the REAL script and the REAL runner against
 * throwaway trees: the zero rule, the refusal to re-seed an allowlist, and the
 * non-obvious ways the tree names an index (a listing descriptor's `index:`
 * literal, a search index, a `const foo = defineTable()` binding), so an edit
 * that neuters the extraction is caught.
 */

import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { API_ROOT, removeTrees, runGate } from './convexGates.testlib';

const GATE = 'check-unused-indexes.sh';
const RATCHET = fileURLToPath(new URL('../ratchet.sh', import.meta.url));

const roots: string[] = [];
afterAll(() => removeTrees(roots));

interface Fixture {
	/** Contents of `convex/schema/tables.ts`. */
	schema: string;
	/** Contents of `convex/queries.ts`, the rest of the backend. */
	code?: string;
}

/** A throwaway repository holding the real gate, the real ratchet and `fixture`. */
async function repo(fixture: Fixture): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-unused-indexes-'));
	roots.push(root);
	const files: Record<string, string> = {
		'apps/api/convex/schema/tables.ts': fixture.schema,
		'apps/api/convex/queries.ts': fixture.code ?? '',
	};
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
		const result = await runGate(await repo({ schema: twoIndexTable, code: queriesBoth }), GATE);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('(no baseline, none allowed)');
	});

	it('fails an index declared but never named anywhere as new', async () => {
		const result = await runGate(await repo({ schema: twoIndexTable, code: queriesOwner }), GATE);
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

	it('fails every unused index, with no allowlist to excuse one', async () => {
		const result = await runGate(await repo({ schema: twoIndexTable }), GATE);
		expect(result.code).toBe(1);
		expect(result.output).toContain('FAIL: 2 Convex index(es) declared but never queried:');
		expect(result.output).toContain('widgets.by_fixture_owner');
		expect(result.output).toContain('widgets.by_fixture_status');
	});

	it('refuses to seed an allowlist with --write-baseline', async () => {
		const result = await runGate(await repo({ schema: twoIndexTable }), GATE, ['--write-baseline']);
		expect(result.code).toBe(2);
		expect(result.output).toContain('--zero has no baseline to write');
	});

	it('fails loudly when an index call no longer parses', async () => {
		const wrapped = twoIndexTable.replace(
			"\t\t.index('by_fixture_status', ['status']),",
			"\t\t.index(\n\t\t\t'by_fixture_status',\n\t\t\t['status']\n\t\t),"
		);
		const result = await runGate(await repo({ schema: wrapped, code: queriesOwner }), GATE);
		expect(result.code).toBe(2);
		expect(result.output).toContain('the schema shape changed');
	});

	// The listing descriptors hand lib/listing.ts an index name as data;
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
		const result = await runGate(await repo({ schema: twoIndexTable, code }), GATE, ['--generate']);
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
