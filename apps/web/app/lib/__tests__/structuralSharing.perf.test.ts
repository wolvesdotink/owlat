/**
 * Report-only benchmark of `shareStructure` on a Postbox list page (plan item
 * OW-072), and the checks that keep its fixture faithful to the server.
 *
 * The fidelity block always runs: it pins the fixture to the limits the source
 * states today (the list-row allowlist, the snippet cap, the page sizes), and
 * proves each update exercises the reconciliation path it is named for. The
 * timing block runs only under `bun run perf:bench`, which sets
 * OWLAT_PERF_BENCH_OUT; in CI it is skipped, so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shareStructure } from '../structuralSharing';
import {
	perfBenchOutput,
	sampleTask,
	writeFamilyResult,
} from '../../../../../scripts/perf-bench/sample';
import {
	LIVE_PAGE_SIZE,
	SERVER_PAGE_CLAMP,
	SNIPPET_CODE_POINTS,
	listUpdates,
	type ListPage,
} from './postboxListPageFixture';

const source = (path: string) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const API = '../../../../api/convex/';

/** The quoted names in the source between `start` and the next `end`. */
function quotedNamesBetween(text: string, start: string, end: string): string[] {
	const from = text.indexOf(start);
	expect(from, `"${start}" not found; update the fixture check`).toBeGreaterThanOrEqual(0);
	const body = text.slice(from + start.length, text.indexOf(end, from));
	return [...body.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1] as string);
}

function rowThreadStateKeys(text: string): string[] {
	const from = text.indexOf('export type RowThreadState = {');
	const body = text.slice(from, text.indexOf('\n};', from));
	return [...body.matchAll(/^\t(\w+)\?:/gm)].map((m) => m[1] as string);
}

/** Rows of `result` that are the very objects of `prev`. */
function keptRows(prev: ListPage, result: ListPage): number {
	const previous = new Set<unknown>(prev.messages);
	return result.messages.filter((row) => previous.has(row)).length;
}

const SIZES = [LIVE_PAGE_SIZE, SERVER_PAGE_CLAMP] as const;

describe('Postbox list page fixture fidelity', () => {
	const rowState = source(`${API}mail/mailbox/rowThreadState.ts`);
	const listKeys = quotedNamesBetween(rowState, 'const MAIL_LIST_ROW_KEYS = [', '] as const');
	const threadKeys = rowThreadStateKeys(rowState);

	it('reads the row allowlist and the thread-state keys from the server source', () => {
		expect(listKeys).toContain('_id');
		expect(listKeys).toContain('snippet');
		expect(threadKeys).toEqual(expect.arrayContaining(['briefTop', 'placement', 'category']));
	});

	it.each(SIZES)(
		'a %i-row page carries only fields the server sends, never as undefined',
		(size) => {
			const allowed = new Set([...listKeys, ...threadKeys]);
			const { prev } = listUpdates(size)[0]!;
			expect(prev.messages).toHaveLength(size);
			for (const row of prev.messages) {
				for (const [key, value] of Object.entries(row)) {
					expect(allowed.has(key), `fixture field "${key}" is not on the list row`).toBe(true);
					expect(value).not.toBeUndefined();
				}
			}
			// The nested parts the reconciliation walks are all present somewhere.
			const used = new Set(prev.messages.flatMap((row) => Object.keys(row)));
			for (const nested of [
				'attachments',
				'unsubscribe',
				'briefTop',
				'senderHeuristics',
				'labelIds',
			]) {
				expect(used.has(nested), `no row carries ${nested}`).toBe(true);
			}
		}
	);

	it('keeps snippets within the server cap', () => {
		expect(source(`${API}mail/deliveryPipeline/insert.ts`)).toContain(
			`truncateCodePoints(source, ${SNIPPET_CODE_POINTS})`
		);
		for (const row of listUpdates(SERVER_PAGE_CLAMP)[0]!.prev.messages) {
			expect(Array.from(row.snippet).length).toBeLessThanOrEqual(SNIPPET_CODE_POINTS);
		}
	});

	it('uses the page sizes the client asks for and the server allows', () => {
		expect(source(`${API}mail/mailbox/queries.ts`)).toContain(
			`Math.min(args.limit ?? ${LIVE_PAGE_SIZE}, ${SERVER_PAGE_CLAMP})`
		);
		expect(source('../../composables/postbox/usePostboxThreads.ts')).toContain(
			`limit: ${LIVE_PAGE_SIZE},`
		);
	});

	it('builds the same page on every call', () => {
		expect(JSON.stringify(listUpdates(LIVE_PAGE_SIZE))).toBe(
			JSON.stringify(listUpdates(LIVE_PAGE_SIZE))
		);
	});

	it.each(SIZES)('each update on a %i-row page takes the path it is named for', (size) => {
		for (const update of listUpdates(size)) {
			const result = shareStructure(update.prev, update.next);
			expect(result, update.name).toEqual(update.next);
			if (update.keptRows === size) expect(result, update.name).toBe(update.prev);
			else expect(keptRows(update.prev, result), update.name).toBe(update.keptRows);
		}
	});
});

const output = perfBenchOutput();

describe.runIf(output)('structural sharing benchmark (perf:bench only)', () => {
	it('samples shareStructure on every update', { timeout: 300_000 }, () => {
		const tasks = SIZES.flatMap((size) =>
			listUpdates(size).map((update) =>
				sampleTask(`${update.name}, ${size} rows`, () => shareStructure(update.prev, update.next), {
					warmup: 200,
					samples: 300,
					// Keeps one sample well above timer resolution at either size.
					opsPerSample: size === LIVE_PAGE_SIZE ? 20 : 2,
				})
			)
		);
		const live = listUpdates(LIVE_PAGE_SIZE)[0]!.prev;
		const clamp = listUpdates(SERVER_PAGE_CLAMP)[0]!.prev;
		writeFamilyResult(output!, {
			family: 'structural-sharing',
			title: 'shareStructure on a Postbox listMessages page',
			dataset: {
				'call site': 'useConvexQuery accept (apps/web/app/composables/useConvexQuery.ts)',
				'page shape':
					'{ messages, hasMore, nextCursor }, rows = MAIL_LIST_ROW_KEYS + RowThreadState',
				'page sizes': `${LIVE_PAGE_SIZE} (live first page, usePostboxThreads) and ${SERVER_PAGE_CLAMP} (server clamp)`,
				[`${LIVE_PAGE_SIZE}-row page`]: `${new Set(live.messages.map((r) => r.threadId)).size} threads, ${JSON.stringify(live).length} bytes of JSON`,
				[`${SERVER_PAGE_CLAMP}-row page`]: `${new Set(clamp.messages.map((r) => r.threadId)).size} threads, ${JSON.stringify(clamp).length} bytes of JSON`,
				updates: 'each a fresh JSON-parsed page, as the Convex client delivers it',
				fixture: 'apps/web/app/lib/__tests__/postboxListPageFixture.ts (seeded, deterministic)',
			},
			tasks,
		});
		expect(tasks.length).toBe(SIZES.length * 5);
	});
});
