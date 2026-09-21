/**
 * Self-test for the `scripts/check-unused-indexes.sh` ratchet. The gate is only
 * worth having if it still recognises the non-obvious ways this tree names an
 * index — a listing descriptor's `index:`/`filterIndexes:` literal, a search
 * index — so those shapes are pinned here alongside the plain pass/fail cases.
 * It guards the guard: an edit that neuters the extraction is caught by CI.
 *
 * The fixture index names carry a `fixture` infix on purpose. The gate counts
 * any quoted identifier under convex/ as a reference, so a fixture named after
 * a real index — `by_owner`, say — would vouch for that index from inside this
 * file and quietly excuse it from the ratchet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'scripts',
	'check-unused-indexes.sh'
);

let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'unused-indexes-ratchet-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

interface Fixture {
	/** Contents of `<root>/schema/tables.ts`. */
	schema: string;
	/** Contents of `<root>/queries.ts` — the "rest of the backend". */
	code?: string;
	/** Allowlist file contents; omitted means no allowlist file at all. */
	allowlist?: string;
}

/** Materialise a fixture tree and run the ratchet over it. Returns the exit code. */
function runRatchet(name: string, fixture: Fixture): number {
	const root = join(workDir, name);
	mkdirSync(join(root, 'schema'), { recursive: true });
	writeFileSync(join(root, 'schema', 'tables.ts'), fixture.schema);
	writeFileSync(join(root, 'queries.ts'), fixture.code ?? '');
	const allowlistPath = join(root, 'allowlist.txt');
	writeFileSync(allowlistPath, fixture.allowlist ?? '');
	try {
		execFileSync('bash', [scriptPath, root, allowlistPath], { encoding: 'utf8', stdio: 'pipe' });
		return 0;
	} catch (err) {
		const status = (err as { status?: number }).status;
		return typeof status === 'number' ? status : 1;
	}
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

describe('check-unused-indexes.sh ratchet', () => {
	it('passes when every declared index is queried', () => {
		expect(
			runRatchet('clean', {
				schema: twoIndexTable,
				code: [
					"await db.query('widgets').withIndex('by_fixture_owner', (q) => q.eq('ownerId', id));",
					"await db.query('widgets').withIndex('by_fixture_status', (q) => q.eq('status', 'live'));",
					'',
				].join('\n'),
			})
		).toBe(0);
	});

	it('fails when an index is declared but never named anywhere', () => {
		expect(
			runRatchet('unused', {
				schema: twoIndexTable,
				code: "await db.query('widgets').withIndex('by_fixture_owner', (q) => q.eq('ownerId', id));\n",
			})
		).toBe(1);
	});

	it('passes an unused index that the allowlist names', () => {
		expect(
			runRatchet('allowlisted', {
				schema: twoIndexTable,
				code: "await db.query('widgets').withIndex('by_fixture_owner', (q) => q.eq('ownerId', id));\n",
				allowlist: '# a landing change will query this\nwidgets.by_fixture_status\n',
			})
		).toBe(0);
	});

	it('fails a stale allowlist entry whose index is now queried', () => {
		expect(
			runRatchet('stale-now-used', {
				schema: twoIndexTable,
				code: [
					"await db.query('widgets').withIndex('by_fixture_owner', (q) => q.eq('ownerId', id));",
					"await db.query('widgets').withIndex('by_fixture_status', (q) => q.eq('status', 'live'));",
					'',
				].join('\n'),
				allowlist: 'widgets.by_fixture_status\n',
			})
		).toBe(1);
	});

	it('fails a stale allowlist entry whose index no longer exists', () => {
		expect(
			runRatchet('stale-deleted', {
				schema: twoIndexTable,
				code: [
					"await db.query('widgets').withIndex('by_fixture_owner', (q) => q.eq('ownerId', id));",
					"await db.query('widgets').withIndex('by_fixture_status', (q) => q.eq('status', 'live'));",
					'',
				].join('\n'),
				allowlist: 'widgets.by_fixture_gone\n',
			})
		).toBe(1);
	});

	// The ADR-0037 listing descriptors hand lib/listing.ts an index name as data;
	// the `.withIndex()` call itself takes a variable, so only the descriptor
	// literal can vouch for the index.
	it('counts a listing descriptor index literal as a reference', () => {
		expect(
			runRatchet('descriptor', {
				schema: twoIndexTable,
				code: [
					'export const widgetListing = {',
					"\ttable: 'widgets',",
					"\tbrowse: { index: 'by_fixture_owner', order: 'desc' },",
					"\tfilters: [{ field: 'status' }],",
					"\tbrowseFilterIndexes: { status: 'by_fixture_status' },",
					'};',
					'',
				].join('\n'),
			})
		).toBe(0);
	});

	it('recognises a search index and its withSearchIndex reference', () => {
		const schema = [
			'export const tables = {',
			'\twidgets: defineTable({ name: v.string() })',
			"\t\t.searchIndex('search_fixture_widgets', { searchField: 'name' })",
			"\t\t.searchIndex('search_fixture_notes', { searchField: 'notes' }),",
			'};',
			'',
		].join('\n');
		expect(
			runRatchet('search-used', {
				schema,
				code: [
					"await db.query('widgets').withSearchIndex('search_fixture_widgets', (q) => q.search('name', t));",
					"await db.query('widgets').withSearchIndex('search_fixture_notes', (q) => q.search('notes', t));",
					'',
				].join('\n'),
			})
		).toBe(0);
		expect(
			runRatchet('search-unused', {
				schema,
				code: "await db.query('widgets').withSearchIndex('search_fixture_widgets', (q) => q.search('name', t));\n",
			})
		).toBe(1);
	});

	it('attributes an index to a `const foo = defineTable()` binding', () => {
		expect(
			runRatchet('const-binding', {
				schema: [
					'const widgets = defineTable({ ownerId: v.string() })',
					"\t.index('by_fixture_owner', ['ownerId']);",
					'export const tables = { widgets };',
					'',
				].join('\n'),
				allowlist: 'widgets.by_fixture_owner\n',
			})
		).toBe(0);
	});
});
