// @vitest-environment happy-dom
/**
 * Drafts: a reply draft is continued in Answer mode on the message it answers
 * (every reply is written there); a new email reopens in a popup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxDraftList from '../PostboxDraftList.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({ api: { mail: { drafts: { listForMailbox: {} } } } }));

const stackOpen = vi.fn();
const navigateTo = vi.fn();
const drafts = ref<unknown[]>([]);

beforeEach(() => {
	stackOpen.mockClear();
	navigateTo.mockClear();
	const state = new Map<string, ReturnType<typeof ref>>();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useConvexQuery', () => ({ data: drafts, isLoading: ref(false) }));
	vi.stubGlobal('usePostboxComposerStack', () => ({ open: stackOpen }));
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
	toAddresses: ['jonas@example.com'],
	subject: 'Re: September invoice',
	bodyHtml: '<p>Here it is</p>',
	lastEditedAt: Date.now(),
	state: 'draft',
	...over,
});

function mountList() {
	return mount(PostboxDraftList, {
		props: { mailboxId: 'mbx_1' as never },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('PostboxDraftList', () => {
	it('continues a reply draft in Answer mode', async () => {
		drafts.value = [draft({ inReplyToMessageId: 'msg_1' })];
		await mountList().get('button').trigger('click');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg_1?draft=draft_1');
		expect(stackOpen).not.toHaveBeenCalled();
	});

	it('reopens a new email in a popup', async () => {
		drafts.value = [draft({ subject: 'Hello' })];
		await mountList().get('button').trigger('click');
		expect(stackOpen).toHaveBeenCalledWith({ mailboxId: 'mbx_1', draftId: 'draft_1' });
		expect(navigateTo).not.toHaveBeenCalled();
	});
});
