/**
 * The reader's view state (SPEC §7):
 *   - the switch shows the view and saves it for this thread;
 *   - a cite opens Conversation for the visit and NEVER writes a preference,
 *     nor does going back to the Overview;
 *   - a thread with no interpretation opens on Conversation;
 *   - a shared (team) mailbox reads no brief and shows no switch, no Overview
 *     and no per-message latest lines;
 *   - a cited message on an earlier, unloaded page is walked back to, expanded
 *     and marked, or said to be out of reach;
 *   - the messages whose exact wording matters are loaded and kept expanded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { briefView } from '~/utils/__tests__/threadBriefFixtures';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			interpret: {
				brief: {
					get: 'brief.get',
					markSeen: 'brief.markSeen',
					setViewOverride: 'brief.setViewOverride',
				},
				lazy: { ensure: 'lazy.ensure' },
				preferences: { getViewPreference: 'pref.get', setThreadDefaultView: 'pref.set' },
			},
		},
	},
}));
vi.mock('~/composables/threadBrief/briefApi', () => ({
	interpretApi: {
		reactions: new Proxy({}, { get: (_t, key) => `reactions.${String(key)}` }),
	},
	briefLocale: () => 'en',
}));

const route = reactive<{ query: Record<string, unknown> }>({ query: {} });
const replace = vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
	route.query = query;
});
const data: Record<string, ReturnType<typeof ref>> = {};
const queryArgs: Record<string, unknown[]> = {};
const runs: Record<string, ReturnType<typeof vi.fn>> = {};
const scope = ref<'personal' | 'shared'>('personal');

const i18n = createTestI18n().global;
vi.stubGlobal('useI18n', () => i18n);
vi.stubGlobal('useRoute', () => route);
vi.stubGlobal('useRouter', () => ({ replace }));
vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
vi.stubGlobal('useInboxes', () => ({
	byId: ref(new Map([['mb1', { scope: scope.value }]])),
}));
vi.stubGlobal('useConvexQuery', (fn: string, args: unknown) => {
	const resolved = typeof args === 'function' ? (args as () => unknown)() : args;
	// A later item page of the brief answers under `brief.get#<cursor>`.
	const cursor =
		typeof resolved === 'object' && resolved !== null
			? (resolved as { cursor?: string }).cursor
			: undefined;
	const key = cursor ? `${fn}#${cursor}` : fn;
	(queryArgs[key] ??= []).push(resolved);
	data[key] ??= ref(undefined);
	return { data: data[key], isLoading: ref(false), error: ref(null) };
});
vi.stubGlobal('useBackendOperation', (fn: string) => {
	runs[fn] ??= vi.fn(async () => ({ ok: true, result: null }));
	return { run: runs[fn], isLoading: ref(false) };
});

const { usePostboxReaderBrief } = await import('../postbox/usePostboxReaderBrief');

interface Msg {
	_id: string;
	fromName?: string;
	fromAddress: string;
	receivedAt: number;
}
const JONAS = { fromName: 'Jonas Weber', fromAddress: 'jonas@kestrel.example' };

function setup(
	over: {
		messages?: Msg[];
		hasEarlier?: boolean;
		older?: Msg[][];
	} = {}
) {
	const expanded = ref(new Set<string>());
	const messages = ref<Msg[]>(over.messages ?? [{ _id: 'm6', ...JONAS, receivedAt: 1 }]);
	const older = [...(over.older ?? [])];
	const hasEarlier = ref(over.hasEarlier ?? false);
	const loadingEarlier = ref(false);
	const loadEarlier = vi.fn(() => {
		const page = older.shift();
		if (page) messages.value = [...page, ...messages.value];
		hasEarlier.value = older.length > 0;
	});
	const state = usePostboxReaderBrief({
		mailboxId: () => 'mb1',
		threadId: () => 't1',
		messages,
		expanded,
		toggleExpanded: (id) => {
			expanded.value = new Set([...expanded.value, id]);
		},
		pages: { hasEarlier, loadingEarlier, loadEarlier },
		secureClass: () => 'none',
		onReply: vi.fn(),
	});
	return Object.assign(state, { expandedIds: expanded, loadEarlier });
}

beforeEach(() => {
	route.query = {};
	replace.mockClear();
	scope.value = 'personal';
	for (const key of Object.keys(data)) delete data[key];
	for (const key of Object.keys(queryArgs)) delete queryArgs[key];
	for (const key of Object.keys(runs)) delete runs[key];
	data['brief.get'] = ref(
		briefView({ messageLatest: [{ messageId: 'm6', text: 'Wants two changes.' }] })
	);
	data['pref.get'] = ref({ threadDefaultView: 'overview' });
});

describe('the reader view', () => {
	it('opens on the Overview and saves a switch for this thread', async () => {
		const state = setup();
		expect(state.switchView.value).toBe('overview');
		expect(state.showsOverview.value).toBe(true);

		state.setView('conversation');
		await nextTick();
		expect(state.showsOverview.value).toBe(false);
		expect(runs['brief.setViewOverride']).toHaveBeenCalledWith({
			threadRef: { kind: 'mail', id: 't1' },
			view: 'conversation',
		});
	});

	it('a cite opens Conversation, marks the quote, and never writes a preference', async () => {
		const state = setup();
		state.openCite('i_contract', 0);
		await nextTick();
		expect(route.query['cite']).toBe('i_contract:0');
		expect(state.switchView.value).toBe('conversation');
		expect(state.citeQuoteFor('m6')).toEqual({ quote: 'Send the signed contract as a PDF' });
		expect(state.citeState.value).toBe('shown');
		expect(state.citeQuoteFor('m1')).toBeNull();

		state.backToOverview();
		await nextTick();
		expect(route.query['cite']).toBeUndefined();
		expect(state.switchView.value).toBe('overview');
		expect(runs['brief.setViewOverride']).not.toHaveBeenCalled();
		expect(runs['pref.set']).toBeUndefined();
	});

	it('opens on Conversation when there is no interpretation, and asks for one once', () => {
		data['brief.get'] = ref(briefView({ completeness: 'none' }));
		expect(setup().switchView.value).toBe('conversation');
		setup();
		expect(runs['lazy.ensure']).toHaveBeenCalledTimes(1);
		expect(runs['lazy.ensure']).toHaveBeenCalledWith({ threadRef: { kind: 'mail', id: 't1' } });
	});

	it('marks the brief seen once the Overview shows it', () => {
		setup();
		expect(runs['brief.markSeen']).toHaveBeenCalledWith({
			threadRef: { kind: 'mail', id: 't1' },
			interpretationRevision: 4,
		});
	});

	it('gives collapsed messages their latest line', () => {
		expect(setup().latestFor('m6')).toBe('Wants two changes.');
	});
});

describe('a shared mailbox', () => {
	it('reads no brief, and shows no switch, no Overview and no latest lines', () => {
		scope.value = 'shared';
		const state = setup();
		expect(queryArgs['brief.get']).toEqual(['skip']);
		expect(queryArgs['pref.get']).toEqual(['skip']);
		expect(state.switchView.value).toBeNull();
		expect(state.showsOverview.value).toBe(false);
		expect(state.latestFor('m6')).toBeNull();
		expect(runs['brief.markSeen']).not.toHaveBeenCalled();
	});
});

describe('a cited message beyond the loaded pages', () => {
	/** A thread of 120 messages: the newest 50 loaded, the cited one on the third page. */
	function longThread() {
		const page = (from: number, to: number) =>
			Array.from({ length: to - from }, (_, i) => ({
				_id: `m${from + i}`,
				...JONAS,
				receivedAt: from + i,
			}));
		return {
			messages: page(70, 120),
			older: [page(20, 70), page(0, 20)],
			hasEarlier: true,
		};
	}

	it('walks back to it, expands it and marks its quote', async () => {
		data['brief.get'] = ref(
			briefView({
				forYou: [
					{
						...briefView().forYou[0]!,
						evidence: [
							{
								source: { kind: 'mail', id: 'm5' as never },
								segmentId: 's0',
								start: 0,
								end: 9,
								contentRevision: 'r1',
								quote: 'by Friday',
								occurrence: 1,
								occurrenceCount: 2,
							},
						],
					},
				],
			})
		);
		const state = setup(longThread());
		state.openCite('i_quote', 0);
		await nextTick();
		await nextTick();
		await nextTick();
		expect(state.loadEarlier).toHaveBeenCalledTimes(2);
		expect(state.citeState.value).toBe('shown');
		expect(state.expandedIds.value.has('m5')).toBe(true);
		expect(state.citeQuoteFor('m5')).toEqual({
			quote: 'by Friday',
			occurrence: 1,
			occurrenceCount: 2,
		});
	});

	it('says the message is out of reach when no earlier page has it', async () => {
		data['brief.get'] = ref(
			briefView({
				forYou: [
					{
						...briefView().forYou[0]!,
						evidence: [
							{
								...briefView().forYou[0]!.evidence[0]!,
								source: { kind: 'mail', id: 'gone' as never },
							},
						],
					},
				],
			})
		);
		const state = setup();
		state.openCite('i_quote', 0);
		await nextTick();
		expect(state.citeState.value).toBe('unreachable');
	});
});

describe('exact wording', () => {
	it('loads and expands the messages whose wording matters', async () => {
		data['brief.get'] = ref(briefView({ exactWording: [{ messageId: 'm6', reason: 'legal' }] }));
		const state = setup();
		await nextTick();
		expect(state.exactWording.value.has('m6')).toBe(true);
		expect(state.expandedIds.value.has('m6')).toBe(true);
	});

	it('keeps none open on a shared mailbox', () => {
		scope.value = 'shared';
		data['brief.get'] = ref(briefView({ exactWording: [{ messageId: 'm6' }] }));
		expect(setup().exactWording.value.size).toBe(0);
	});
});

describe('the brief beyond its first item page', () => {
	it('walks to the page holding the obligation behind 100 waiting items', async () => {
		const waiting = briefView().waitingOnOthers[0]!;
		data['brief.get'] = ref(
			briefView({
				forYou: [],
				waitingOnOthers: Array.from({ length: 100 }, (_, i) => ({
					...waiting,
					id: `w${i}` as never,
				})),
				counts: { forYou: 1, forTeam: 0, waitingOnOthers: 100, unclear: 0, closed: 0, hidden: 0 },
				page: { cursor: 'c1', isDone: false, isClosedTruncated: false },
			})
		);
		const state = setup();
		await nextTick();
		expect(queryArgs['brief.get#c1']?.[0]).toMatchObject({ cursor: 'c1' });
		expect(state.itemsState.value).toBe('loading');
		data['brief.get#c1']!.value = briefView({
			forYou: [{ ...briefView().forYou[0]!, id: 'pay' as never, text: 'Pay €38.08' }],
			waitingOnOthers: [],
			page: { cursor: 'c2', isDone: true, isClosedTruncated: false },
		});
		await nextTick();
		expect(state.itemsState.value).toBe('complete');
		expect(state.brief.value?.forYou.map((i) => i.id)).toEqual(['pay']);
		expect(state.brief.value?.waitingOnOthers).toHaveLength(100);
	});
});

describe('a brief whose pages are already in the cache', () => {
	it('walks on to the third page and finishes', async () => {
		const base = briefView();
		const tracked = (id: string) => ({ ...base.forYou[0]!, id: id as never, text: id });
		data['brief.get'] = ref(
			briefView({
				forYou: [tracked('a')],
				page: { cursor: 'c1', isDone: false, isClosedTruncated: false },
			})
		);
		data['brief.get#c1'] = ref(
			briefView({
				forYou: [tracked('b')],
				page: { cursor: 'c2', isDone: false, isClosedTruncated: false },
			})
		);
		data['brief.get#c2'] = ref(
			briefView({
				forYou: [tracked('c')],
				page: { cursor: 'c3', isDone: true, isClosedTruncated: false },
			})
		);
		const state = setup();
		await nextTick();
		await nextTick();
		expect(queryArgs['brief.get#c2']?.[0]).toMatchObject({ cursor: 'c2' });
		expect(state.itemsState.value).toBe('complete');
		expect(state.brief.value?.forYou.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
	});
});
