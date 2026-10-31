/**
 * Report-only benchmark of `shareStructure` on a Postbox list page (plan item
 * OW-072), and the client-side checks of its fixture
 * (scripts/perf-bench/postboxListPage.ts).
 *
 * The fidelity block always runs. Here it checks what the client side owns: the
 * page size `usePostboxThreads` asks for, the thread-state invariants
 * `attachThreadState` guarantees, and that each update exercises the
 * reconciliation path it is named for. The row projection, snippet cap and
 * server page sizes are held by executable contracts on the API side
 * (apps/api/convex/mail/__tests__/perfListFixtureContract.test.ts).
 *
 * The timing block runs only under `bun run perf:bench`, which sets
 * OWLAT_PERF_BENCH_OUT; in CI it is skipped, so no timing is ever asserted.
 */
import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { shareStructure } from '../structuralSharing';
import { usePostboxThreads } from '../../composables/postbox/usePostboxThreads';
import {
	perfBenchOutput,
	sampleTask,
	writeFamilyResult,
} from '../../../../../scripts/perf-bench/sample';
import {
	LIVE_PAGE_SIZE,
	SERVER_PAGE_CLAMP,
	THREAD_STATE_KEYS,
	jsonBytes,
	listUpdates,
	type ListPage,
	type ListRow,
} from '../../../../../scripts/perf-bench/postboxListPage';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** Rows of `result` that are the very objects of `prev`. */
function keptRows(prev: ListPage, result: ListPage): number {
	const previous = new Set<unknown>(prev.messages);
	return result.messages.filter((row) => previous.has(row)).length;
}

function rowsByThread(page: ListPage): Map<string, ListRow[]> {
	const threads = new Map<string, ListRow[]>();
	for (const row of page.messages) {
		threads.set(row.threadId, [...(threads.get(row.threadId) ?? []), row]);
	}
	return threads;
}

/** A row's thread state with the per-message part (`followUp.watched`) left out. */
function sharedThreadState(row: ListRow): string {
	const state: Record<string, unknown> = {};
	for (const key of THREAD_STATE_KEYS) state[key] = row[key];
	if (row.followUp) state['followUp'] = { ...row.followUp, watched: undefined };
	return JSON.stringify(state);
}

const SIZES = [LIVE_PAGE_SIZE, SERVER_PAGE_CLAMP] as const;

describe('Postbox list page fixture fidelity', () => {
	it('pages the way usePostboxThreads asks for the live first page', () => {
		let args: (() => unknown) | undefined;
		vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), isLoading: ref(true) }));
		vi.stubGlobal('usePostboxCursorFeed', (_query: unknown, factory: () => unknown) => {
			args = factory;
			return { rows: computed(() => []), isLoading: ref(false), hasMore: computed(() => false) };
		});
		usePostboxThreads({
			mailboxId: ref('mailbox-1' as Id<'mailboxes'>),
			folderRole: ref('inbox'),
		});
		vi.unstubAllGlobals();
		expect(args?.()).toMatchObject({ limit: LIVE_PAGE_SIZE });
	});

	it.each(SIZES)('a %i-row page has the size asked for and no undefined fields', (size) => {
		const { prev } = listUpdates(size)[0]!;
		expect(prev.messages).toHaveLength(size);
		for (const row of prev.messages) expect(Object.values(row)).not.toContain(undefined);
		// The nested parts the reconciliation walks are all present somewhere.
		const used = new Set(prev.messages.flatMap((row) => Object.keys(row)));
		for (const nested of [
			'attachments',
			'unsubscribe',
			'briefTop',
			'senderHeuristics',
			'followUp',
		]) {
			expect(used.has(nested), `no row carries ${nested}`).toBe(true);
		}
	});

	it.each(SIZES)('on a %i-row page every row of a thread carries its thread state', (size) => {
		const threads = rowsByThread(listUpdates(size)[0]!.prev);
		expect([...threads.values()].some((rows) => rows.length > 1)).toBe(true);
		for (const rows of threads.values()) {
			expect(new Set(rows.map(sharedThreadState)).size).toBe(1);
			expect(rows.filter((row) => row.followUp?.watched).length).toBeLessThanOrEqual(1);
		}
	});

	it.each(SIZES)('a brief update on a %i-row page reaches every row of its thread', (size) => {
		const update = listUpdates(size).find((u) => u.name.startsWith('brief line'))!;
		const before = rowsByThread(update.prev);
		const after = rowsByThread(update.next);
		const changed = [...after.entries()].filter(
			([threadId, rows]) => JSON.stringify(rows) !== JSON.stringify(before.get(threadId))
		);
		expect(changed).toHaveLength(1);
		const [, rows] = changed[0]!;
		expect(rows.length).toBeGreaterThan(1);
		expect(new Set(rows.map(sharedThreadState)).size).toBe(1);
		expect(rows.every((row) => row.briefTop?.latest?.en === 'Moved to Thursday.')).toBe(true);
		expect(update.keptRows).toBe(size - rows.length);
	});

	it.each(SIZES)('marking read on a %i-row page turns one unread row read', (size) => {
		const update = listUpdates(size).find((u) => u.name === 'one row marked read')!;
		const changed = update.next.messages
			.map((row, i) => ({ before: update.prev.messages[i]!, after: row }))
			.filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
		expect(changed).toHaveLength(1);
		const [{ before, after }] = changed as [(typeof changed)[number]];
		expect([before.flagSeen, after.flagSeen]).toEqual([false, true]);
		expect({ ...after, flagSeen: before.flagSeen }).toStrictEqual(before);
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
	it('samples shareStructure on every update', () => {
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
		const describePage = (size: number) => {
			const { prev } = listUpdates(size)[0]!;
			const threads = rowsByThread(prev);
			const shared = [...threads.values()].filter((rows) => rows.length > 1).length;
			return `${threads.size} threads (${shared} with several rows), ${jsonBytes(prev)} bytes of UTF-8 JSON`;
		};
		writeFamilyResult(output!, {
			family: 'structural-sharing',
			title: 'shareStructure on a Postbox listMessages page',
			dataset: {
				'call site': 'useConvexQuery accept (apps/web/app/composables/useConvexQuery.ts)',
				'page shape':
					'{ messages, hasMore, nextCursor }, rows = MAIL_LIST_ROW_KEYS + RowThreadState, thread state shared per thread',
				'page sizes': `${LIVE_PAGE_SIZE} (live first page, usePostboxThreads) and ${SERVER_PAGE_CLAMP} (server clamp)`,
				[`${LIVE_PAGE_SIZE}-row page`]: describePage(LIVE_PAGE_SIZE),
				[`${SERVER_PAGE_CLAMP}-row page`]: describePage(SERVER_PAGE_CLAMP),
				updates: 'each a fresh JSON-parsed page, as the Convex client delivers it',
				fixture: 'scripts/perf-bench/postboxListPage.ts (seeded, deterministic)',
			},
			tasks,
		});
		expect(tasks.length).toBe(SIZES.length * 5);
	});
});
