/**
 * Drafts: a reply draft is continued in Answer mode on the message it answers
 * (every reply is written there); a new email reopens on the compose page, in
 * the draft's own mailbox, also from All drafts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxDraftList from '../PostboxDraftList.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			drafts: { listForMailbox: { name: 'single' } },
			mailbox: { allInboxes: { listDrafts: { name: 'merged' } } },
		},
	},
}));

const composeOpen = vi.fn();
const navigateTo = vi.fn();
const drafts = ref<unknown[]>([]);
const asked: { query: unknown; args: unknown }[] = [];

beforeEach(() => {
	composeOpen.mockClear();
	navigateTo.mockClear();
	const state = new Map<string, ReturnType<typeof ref>>();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	asked.length = 0;
	vi.stubGlobal('useConvexQuery', (query: unknown, args: () => unknown) => {
		asked.push({ query, args: args() });
		return { data: args() === 'skip' ? ref(undefined) : drafts, isLoading: ref(false) };
	});
	vi.stubGlobal('useInboxes', () => ({
		byId: ref(new Map([['mbx_2', { mailboxId: 'mbx_2', name: 'Support', slot: 1 }]])),
	}));
	vi.stubGlobal('usePostboxComposeNav', () => ({ open: composeOpen }));
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
	vi.stubGlobal('useRouter', () => ({
		currentRoute: ref({ path: '/dashboard/postbox/drafts', fullPath: '/dashboard/postbox/drafts' }),
	}));
	vi.stubGlobal('navigateTo', navigateTo);
});

const draft = (over: Record<string, unknown>) => ({
	_id: 'draft_1',
	mailboxId: 'mbx_1',
	toAddresses: ['jonas@example.com'],
	subject: 'Re: September invoice',
	bodyHtml: '<p>Here it is</p>',
	lastEditedAt: Date.now(),
	state: 'draft',
	...over,
});

function mountList(props: Record<string, unknown> = { mailboxId: 'mbx_1' }) {
	return mount(PostboxDraftList, {
		props: props as never,
		global: { plugins: [createTestI18n()] },
	});
}

describe('PostboxDraftList', () => {
	it('continues a reply draft in Answer mode', async () => {
		drafts.value = [draft({ inReplyToMessageId: 'msg_1' })];
		await mountList().get('button').trigger('click');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg_1?draft=draft_1');
		expect(composeOpen).not.toHaveBeenCalled();
	});

	it('reopens a new email on the compose page', async () => {
		drafts.value = [draft({ subject: 'Hello' })];
		await mountList().get('button').trigger('click');
		expect(composeOpen).toHaveBeenCalledWith({ mailboxId: 'mbx_1', draftId: 'draft_1' });
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('lists All drafts from the merged query and reopens a draft in its own mailbox', async () => {
		drafts.value = [draft({ _id: 'draft_2', mailboxId: 'mbx_2', subject: 'Hello' })];
		const wrapper = mountList({ mailboxIds: ['mbx_1', 'mbx_2'] });

		expect(asked).toEqual([
			{ query: { name: 'single' }, args: 'skip' },
			{ query: { name: 'merged' }, args: { mailboxIds: ['mbx_1', 'mbx_2'] } },
		]);
		expect(wrapper.text()).toContain('Support');
		await wrapper.get('button').trigger('click');
		expect(composeOpen).toHaveBeenCalledWith({ mailboxId: 'mbx_2', draftId: 'draft_2' });
	});
});
