// @vitest-environment happy-dom
/**
 * The catch-up card's data (composables/useAnswerCatchUp):
 *   - `ensure` runs once per open, and not at all with AI off;
 *   - the reactive cache wins over what `ensure` returned; a failure hides it;
 *   - a short thread without a card opens in full, decided once.
 *
 * What the draft covers is the response plan's (useResponsePlan.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useAnswerCatchUp, type AnswerCatchUpTarget } from '../useAnswerCatchUp';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			ai: {
				catchUpStore: { get: 'mail.get' },
				catchUp: { ensure: 'mail.ensure' },
			},
		},
		inbox: {
			catchUpStore: { get: 'team.get' },
			catchUp: { ensure: 'team.ensure' },
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
function host(
	target: Ref<AnswerCatchUpTarget | null>,
	_draftText: Ref<string>,
	conversation?: { view: Ref<AnswerConversationView>; count: Ref<number | undefined> }
) {
	let api!: ReturnType<typeof useAnswerCatchUp>;
	const Host = defineComponent({
		setup() {
			api = useAnswerCatchUp({
				target: () => target.value,
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
