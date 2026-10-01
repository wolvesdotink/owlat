// @vitest-environment happy-dom
/**
 * The catch-up card's data (composables/useAnswerCatchUp):
 *   - `ensure` runs once per open, and not at all with AI off;
 *   - the reactive cache wins over what `ensure` returned; a failure hides it;
 *   - coverage waits for typing to pause (1.5s), sends the draft's text, and a
 *     newer check always wins over an older one still in flight;
 *   - an empty draft covers nothing without asking the server, and the same
 *     text is not checked twice (an AI draft settles and changes the text);
 *   - the footer note waits for something written;
 *   - a short thread without a card opens in full, decided once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	COVERAGE_DEBOUNCE_MS,
	useAnswerCatchUp,
	type AnswerCatchUpTarget,
} from '../useAnswerCatchUp';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			ai: {
				catchUpStore: { get: 'mail.get' },
				catchUp: { ensure: 'mail.ensure', coverage: 'mail.coverage' },
			},
		},
		inbox: {
			catchUpStore: { get: 'team.get' },
			catchUp: { ensure: 'team.ensure', coverage: 'team.coverage' },
		},
	},
}));

const CARD = {
	sentences: [{ text: 'Jonas asked for the invoice.', sourceMessageIds: ['m1'] }],
	asks: [
		{ id: 'ask_1', text: 'Send the September invoice', sourceMessageId: 'm1' },
		{ id: 'ask_2', text: 'Put the PO number on it', sourceMessageId: 'm1' },
	],
	messageCount: 3,
	locale: 'en',
	generatedAt: 1,
};

let aiOn = true;
const stored: Record<string, Ref<unknown>> = {};
const queryArgs: Record<string, unknown[]> = {};
const action = vi.fn();

beforeEach(() => {
	aiOn = true;
	stored['mail.get'] = ref(undefined);
	stored['team.get'] = ref(undefined);
	queryArgs['mail.get'] = [];
	queryArgs['team.get'] = [];
	action.mockReset();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (flag: string) => flag === 'ai' && aiOn }));
	vi.stubGlobal('useConvexQuery', (fn: string, args: () => unknown) => {
		queryArgs[fn]!.push(args());
		return { data: stored[fn] };
	});
	vi.stubGlobal('requireConvex', () => ({ action }));
});
afterEach(() => {
	vi.useRealTimers();
});

function host(
	target: Ref<AnswerCatchUpTarget | null>,
	draftText: Ref<string>,
	conversation?: { view: Ref<AnswerConversationView>; count: Ref<number | undefined> }
) {
	let api!: ReturnType<typeof useAnswerCatchUp>;
	const Host = defineComponent({
		setup() {
			api = useAnswerCatchUp({
				target: () => target.value,
				draftText: () => draftText.value,
				...(conversation
					? { view: conversation.view, messageCount: () => conversation.count.value }
					: {}),
			});
			return () => h('div');
		},
	});
	const wrapper = mount(Host, { global: { plugins: [createTestI18n()] } });
	return { wrapper, api: () => api };
}

const mail = (id = 'm1'): AnswerCatchUpTarget => ({ kind: 'mail', messageId: id as never });

describe('useAnswerCatchUp: the card', () => {
	it('ensures once per open and shows what came back until the cache arrives', async () => {
		action.mockResolvedValueOnce(CARD);
		const { api } = host(ref(mail()), ref(''));
		expect(api().loading.value).toBe(true);
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(1);
		expect(action).toHaveBeenCalledWith('mail.ensure', { messageId: 'm1', locale: 'en' });
		expect(api().catchUp.value?.asks).toHaveLength(2);
		expect(api().loading.value).toBe(false);

		stored['mail.get']!.value = { ...CARD, asks: [CARD.asks[0]] };
		expect(api().catchUp.value?.asks).toHaveLength(1);
	});

	it('runs again for another thread, and uses the team functions for a team thread', async () => {
		action.mockResolvedValue(null);
		const target = ref<AnswerCatchUpTarget | null>(mail());
		host(target, ref(''));
		await flushPromises();
		target.value = { kind: 'team', threadId: 't1' as never };
		await flushPromises();
		expect(action.mock.calls.map((c) => c[0])).toEqual(['mail.ensure', 'team.ensure']);
		expect(action).toHaveBeenLastCalledWith('team.ensure', { threadId: 't1', locale: 'en' });
	});

	it('asks nothing with AI off', async () => {
		aiOn = false;
		const { api } = host(ref(mail()), ref(''));
		await flushPromises();
		expect(action).not.toHaveBeenCalled();
		expect(queryArgs['mail.get']).toEqual(['skip']);
		expect(api().catchUp.value).toBeNull();
	});

	it('hides the card when ensure fails', async () => {
		action.mockRejectedValueOnce(new Error('budget spent'));
		stored['mail.get']!.value = CARD;
		const { api } = host(ref(mail()), ref(''));
		await flushPromises();
		expect(api().catchUp.value).toBeNull();
		expect(api().loading.value).toBe(false);
	});
});

describe('useAnswerCatchUp: coverage', () => {
	it('checks the draft once typing pauses, and ticks what came back', async () => {
		vi.useFakeTimers();
		action.mockResolvedValueOnce(CARD);
		const text = ref('');
		const { api } = host(ref(mail()), text);
		await flushPromises();

		action.mockResolvedValueOnce({ coveredAskIds: ['ask_2', 'ask_gone'] });
		text.value = 'Hi Jonas, the PO is on it';
		await flushPromises();
		vi.advanceTimersByTime(COVERAGE_DEBOUNCE_MS - 10);
		expect(action).toHaveBeenCalledTimes(1);
		text.value = 'Hi Jonas, the PO is on it.';
		await flushPromises();
		vi.advanceTimersByTime(COVERAGE_DEBOUNCE_MS);
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(2);
		expect(action).toHaveBeenLastCalledWith('mail.coverage', {
			messageId: 'm1',
			draftText: 'Hi Jonas, the PO is on it.',
			locale: 'en',
		});
		// Only ids the card still has.
		expect(api().covered.value).toEqual(['ask_2']);
	});

	it('lets the newest check win over an older one still in flight', async () => {
		action.mockResolvedValueOnce(CARD);
		const text = ref('first');
		const { api } = host(ref(mail()), text);
		await flushPromises();

		let resolveOld!: (value: unknown) => void;
		action.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
		const older = api().checkCoverage();
		text.value = 'second';
		action.mockResolvedValueOnce({ coveredAskIds: ['ask_1'] });
		await api().checkCoverage();
		resolveOld({ coveredAskIds: ['ask_2'] });
		await older;
		expect(api().covered.value).toEqual(['ask_1']);
	});

	it('clears the ticks for an empty draft without asking', async () => {
		action.mockResolvedValueOnce(CARD);
		const text = ref('something');
		const { api } = host(ref(mail()), text);
		await flushPromises();
		action.mockResolvedValueOnce({ coveredAskIds: ['ask_1'] });
		await api().checkCoverage();
		expect(api().covered.value).toEqual(['ask_1']);
		text.value = '   ';
		await api().checkCoverage();
		expect(api().covered.value).toEqual([]);
		expect(action).toHaveBeenCalledTimes(2);
	});
});

describe('useAnswerCatchUp: one check per AI draft', () => {
	it('does not check the same text again after the pause once the settle checked it', async () => {
		vi.useFakeTimers();
		action.mockResolvedValueOnce(CARD);
		const text = ref('');
		const { api } = host(ref(mail()), text);
		await flushPromises();

		// The AI draft lands: the text changes (arming the paused check) and the
		// settle checks at once.
		action.mockResolvedValue({ coveredAskIds: ['ask_1'] });
		text.value = 'Attached the September invoice.';
		await nextTick();
		await api().checkCoverage();
		vi.advanceTimersByTime(COVERAGE_DEBOUNCE_MS * 2);
		await flushPromises();

		expect(action.mock.calls.filter((c) => c[0] === 'mail.coverage')).toHaveLength(1);

		// An edit is new text: checked again.
		text.value = 'Attached the September invoice, PO on it.';
		await nextTick();
		vi.advanceTimersByTime(COVERAGE_DEBOUNCE_MS);
		await flushPromises();
		expect(action.mock.calls.filter((c) => c[0] === 'mail.coverage')).toHaveLength(2);
	});
});

describe('useAnswerCatchUp: the footer note', () => {
	it('says nothing on an untouched reply, then counts the asks covered', async () => {
		action.mockResolvedValueOnce(CARD);
		const text = ref('');
		const { api } = host(ref(mail()), text);
		await flushPromises();
		// "0 of 2 asks covered" on a reply nobody wrote in reads like a warning.
		expect(api().statusNote.value).toBeUndefined();

		text.value = 'Hi Jonas';
		expect(api().statusNote.value).toBe('0 of 2 asks covered');
		action.mockResolvedValueOnce({ coveredAskIds: ['ask_2'] });
		await api().checkCoverage();
		expect(api().statusNote.value).toBe('1 of 2 asks covered');
	});

	it('says nothing without asks', async () => {
		action.mockResolvedValueOnce({ ...CARD, asks: [] });
		const { api } = host(ref(mail()), ref('Hi Jonas'));
		await flushPromises();
		expect(api().statusNote.value).toBeUndefined();
	});
});

describe('useAnswerCatchUp: the opening view', () => {
	it('opens a short thread without a card in full, once', async () => {
		action.mockResolvedValue(null);
		const view = ref<AnswerConversationView>('summary');
		const count = ref<number | undefined>(undefined);
		host(ref(mail()), ref(''), { view, count });
		await flushPromises();
		expect(view.value).toBe('summary');
		count.value = 2;
		await nextTick();
		expect(view.value).toBe('full');
		view.value = 'summary';
		count.value = 1;
		await nextTick();
		expect(view.value).toBe('summary');
	});

	it('stays on Summary with a card, and for a long thread without one', async () => {
		action.mockResolvedValueOnce(CARD);
		const withCard = {
			view: ref<AnswerConversationView>('summary'),
			count: ref<number | undefined>(2),
		};
		host(ref(mail()), ref(''), withCard);
		await flushPromises();
		expect(withCard.view.value).toBe('summary');

		action.mockResolvedValueOnce(null);
		const long = {
			view: ref<AnswerConversationView>('summary'),
			count: ref<number | undefined>(5),
		};
		host(ref(mail('m2')), ref(''), long);
		await flushPromises();
		expect(long.view.value).toBe('summary');
	});
});
