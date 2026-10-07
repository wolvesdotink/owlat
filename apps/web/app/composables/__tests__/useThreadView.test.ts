/**
 * The reader's view state (SPEC §7):
 *   - the switch shows the view and saves it for this thread;
 *   - a cite opens Conversation for the visit and NEVER writes a preference,
 *     nor does going back to the Overview;
 *   - a thread with no interpretation opens on Conversation;
 *   - a shared (team) mailbox reads no brief and shows no switch, no Overview
 *     and no per-message latest lines.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { briefView } from '~/utils/__tests__/threadBriefFixtures';

vi.mock('~/composables/threadBrief/briefApi', () => ({
	interpretApi: {
		brief: {
			get: 'brief.get',
			markSeen: 'brief.markSeen',
			setViewOverride: 'brief.setViewOverride',
		},
		preferences: { getViewPreference: 'pref.get', setThreadDefaultView: 'pref.set' },
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
vi.stubGlobal('useInboxes', () => ({
	byId: ref(new Map([['mb1', { scope: scope.value }]])),
}));
vi.stubGlobal('useConvexQuery', (fn: string, args: unknown) => {
	const resolved = typeof args === 'function' ? (args as () => unknown)() : args;
	(queryArgs[fn] ??= []).push(resolved);
	data[fn] ??= ref(undefined);
	return { data: data[fn], isLoading: ref(false), error: ref(null) };
});
vi.stubGlobal('useBackendOperation', (fn: string) => {
	runs[fn] ??= vi.fn(async () => ({ ok: true, result: null }));
	return { run: runs[fn], isLoading: ref(false) };
});

const { usePostboxReaderBrief } = await import('../postbox/usePostboxReaderBrief');

function setup() {
	const expanded = ref(new Set<string>());
	return usePostboxReaderBrief({
		mailboxId: () => 'mb1',
		threadId: () => 't1',
		messages: ref([
			{ _id: 'm6', fromName: 'Jonas Weber', fromAddress: 'jonas@kestrel.example', receivedAt: 1 },
		]),
		expanded,
		toggleExpanded: (id) => {
			expanded.value = new Set([...expanded.value, id]);
		},
		secureClass: () => 'none',
		onReply: vi.fn(),
	});
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
		expect(state.citeQuoteFor('m6')).toBe('Send the signed contract as a PDF');
		expect(state.citeQuoteFor('m1')).toBeNull();

		state.backToOverview();
		await nextTick();
		expect(route.query['cite']).toBeUndefined();
		expect(state.switchView.value).toBe('overview');
		expect(runs['brief.setViewOverride']).not.toHaveBeenCalled();
		expect(runs['pref.set']).toBeUndefined();
	});

	it('opens on Conversation when there is no interpretation', () => {
		data['brief.get'] = ref(briefView({ completeness: 'none' }));
		expect(setup().switchView.value).toBe('conversation');
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
