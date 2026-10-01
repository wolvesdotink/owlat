// @vitest-environment happy-dom
/**
 * "Draft to Jonas saved · Resume": the reply left in Answer mode, offered back
 * on the list. Resume reopens Answer mode on that draft; × drops the offer
 * (never the draft); a draft sent or discarded elsewhere takes the offer with
 * it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';

import PostboxAnswerDraftBar from '../PostboxAnswerDraftBar.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useAnswerLeftDraft } from '~/composables/useAnswerMode';

vi.mock('@owlat/api', () => ({ api: { mail: { drafts: { get: {} } } } }));

let state: Map<string, ReturnType<typeof ref>>;
const draftRow = ref<unknown>(undefined);
const queryArgs: Array<() => unknown> = [];

beforeEach(() => {
	state = new Map();
	draftRow.value = undefined;
	queryArgs.length = 0;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
	vi.stubGlobal('useConvexQuery', (_q: unknown, args: () => unknown) => {
		queryArgs.push(args);
		return { data: draftRow };
	});
});

function leave() {
	useAnswerLeftDraft().set({
		draftId: 'draft_1' as never,
		messageId: 'msg_1',
		mailboxId: 'mbx_1',
		kind: 'replyAll',
		recipient: 'Jonas',
	});
}

function mountBar() {
	return mount(PostboxAnswerDraftBar, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

describe('PostboxAnswerDraftBar', () => {
	it('renders nothing without a draft left behind, and reads nothing', () => {
		const w = mountBar();
		expect(w.find('[data-testid="answer-draft-bar"]').exists()).toBe(false);
		expect(queryArgs[0]?.()).toBe('skip');
	});

	it('names who the draft is for and resumes it in Answer mode', () => {
		leave();
		const w = mountBar();
		expect(w.text()).toContain('Draft to Jonas saved');
		expect(w.get('a').attributes('href')).toBe(
			'/dashboard/answer/m/msg_1?kind=replyAll&draft=draft_1'
		);
		expect(queryArgs[0]?.()).toEqual({ draftId: 'draft_1' });
	});

	it('drops the offer on ×, leaving the draft alone', async () => {
		leave();
		const w = mountBar();
		await w.get('button').trigger('click');
		expect(useAnswerLeftDraft().left.value).toBeNull();
		expect(w.find('[data-testid="answer-draft-bar"]').exists()).toBe(false);
	});

	it('goes away when the draft was sent or discarded somewhere else', async () => {
		leave();
		mountBar();
		draftRow.value = { _id: 'draft_1', state: 'draft' };
		await nextTick();
		expect(useAnswerLeftDraft().left.value).not.toBeNull();
		draftRow.value = null;
		await nextTick();
		expect(useAnswerLeftDraft().left.value).toBeNull();
	});
});
