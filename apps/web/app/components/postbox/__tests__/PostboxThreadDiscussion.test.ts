// @vitest-environment happy-dom
/**
 * The reader's Team discussion panel (chat.mailDiscussion):
 *   - renders the thread's messages under a "Team discussion · internal · N" head
 *   - shows the empty state before anyone has posted
 *   - Enter posts through the mutation; Shift+Enter does not
 *   - the placeholder names the correspondent it is NOT sent to
 *   - renders nothing when the backend answers null (chat off / no access) or
 *     the chat feature is off
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxThreadDiscussion from '../PostboxThreadDiscussion.vue';
import PostboxThreadDiscussionToggle from '../PostboxThreadDiscussionToggle.vue';
import {
	usePostboxThreadDiscussionData,
	usePostboxThreadDiscussionPanel,
} from '~/composables/postbox/usePostboxThreadDiscussion';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type Discussion = {
	roomId: string | null;
	messages: Array<{
		_id: string;
		authorName: string | null;
		authorImage: string | null;
		body: string;
		createdAt: number;
		isMine: boolean;
	}>;
	count: number;
} | null;

const discussionData = ref<Discussion>(null);
// Nuxt's useState, one shared ref per key — cleared per test so the panel's
// open/closed choice never leaks between cases.
const state = new Map<string, ReturnType<typeof ref>>();
const chatEnabled = ref(true);
const postRun = vi.fn(async (_args: unknown) => ({ ok: true, result: {} }));
const markReadRun = vi.fn(async (_args: unknown) => ({ ok: true, result: null }));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => (flag === 'chat' ? chatEnabled.value : false),
	}));
	vi.stubGlobal('useMediaQuery', () => ref(true));
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: () => unknown) => ({
		data: computedData(args),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: () => string }) => ({
		run: opts.label() === 'Post to the team discussion' ? postRun : markReadRun,
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxThreadDiscussionPanel', usePostboxThreadDiscussionPanel);
	vi.stubGlobal('usePostboxThreadDiscussionData', usePostboxThreadDiscussionData);
});

/** The query answers `discussionData`, and nothing once the args say 'skip'. */
function computedData(args: () => unknown) {
	return {
		get value() {
			return args() === 'skip' ? undefined : discussionData.value;
		},
	};
}

beforeEach(() => {
	state.clear();
	chatEnabled.value = true;
	discussionData.value = { roomId: null, messages: [], count: 0 };
	postRun.mockClear();
	markReadRun.mockClear();
});

const stubs = {
	Icon: { props: ['name'], template: '<span />' },
	UiAvatar: { props: ['name', 'image', 'size'], template: '<span />' },
	UiButton: {
		props: ['disabled', 'loading', 'type'],
		template: '<button :type="type" :disabled="disabled"><slot /></button>',
	},
};

function mountPanel(counterpartyLabel = 'Harborline Ops') {
	return mount(PostboxThreadDiscussion, {
		props: { threadId: 'thread-1', mailboxId: 'mailbox-1', counterpartyLabel },
		global: { plugins: [createTestI18n()], stubs },
	});
}

describe('PostboxThreadDiscussion', () => {
	it('renders the empty state and a composer addressed to the team', () => {
		const wrapper = mountPanel();
		expect(wrapper.text()).toContain('Team discussion');
		expect(wrapper.text()).toContain('internal');
		expect(wrapper.find('[data-testid="thread-discussion-empty"]').text()).toBe(
			'No discussion yet — ask a teammate about this email.'
		);
		expect(wrapper.find('[data-testid="thread-discussion-input"]').attributes('placeholder')).toBe(
			'Write to the team… (not sent to Harborline Ops)'
		);
		// No room yet, so nothing to mark read.
		expect(markReadRun).not.toHaveBeenCalled();
	});

	it('renders the messages and the count, and clears mentions once opened', async () => {
		discussionData.value = {
			roomId: 'room-1',
			count: 2,
			messages: [
				{
					_id: 'm1',
					authorName: 'Ben',
					authorImage: null,
					body: 'Their record has two v=spf1 strings.',
					createdAt: Date.now() - 60_000,
					isMine: false,
				},
				{
					_id: 'm2',
					authorName: null,
					authorImage: null,
					body: 'On it.',
					createdAt: Date.now(),
					isMine: true,
				},
			],
		};
		const wrapper = mountPanel();
		await flushPromises();
		const rows = wrapper.findAll('[data-testid="thread-discussion-message"]');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('Ben');
		expect(rows[0]!.text()).toContain('Their record has two v=spf1 strings.');
		expect(rows[1]!.text()).toContain('Former member');
		expect(wrapper.find('[data-testid="thread-discussion-count"]').text()).toContain('2');
		expect(markReadRun).toHaveBeenCalledWith({ threadId: 'thread-1' });
	});

	it('posts on Enter and clears the draft; Shift+Enter keeps typing', async () => {
		const wrapper = mountPanel();
		const input = wrapper.find('[data-testid="thread-discussion-input"]');
		await input.setValue('@ada can you send them the merged record?');

		await input.trigger('keydown', { key: 'Enter', shiftKey: true });
		expect(postRun).not.toHaveBeenCalled();

		await input.trigger('keydown', { key: 'Enter' });
		await flushPromises();
		expect(postRun).toHaveBeenCalledWith({
			threadId: 'thread-1',
			body: '@ada can you send them the merged record?',
		});
		expect((input.element as HTMLTextAreaElement).value).toBe('');
	});

	it('does not post an empty message', async () => {
		const wrapper = mountPanel();
		await wrapper.find('[data-testid="thread-discussion-input"]').setValue('   ');
		await wrapper.find('form').trigger('submit');
		expect(postRun).not.toHaveBeenCalled();
	});

	it('falls back to "the sender" when there is no external correspondent', () => {
		const wrapper = mountPanel('');
		expect(wrapper.find('[data-testid="thread-discussion-input"]').attributes('placeholder')).toBe(
			'Write to the team… (not sent to the sender)'
		);
	});

	it('renders nothing without access or with chat off', () => {
		discussionData.value = null;
		expect(mountPanel().find('[data-testid="thread-discussion"]').exists()).toBe(false);

		discussionData.value = { roomId: null, messages: [], count: 0 };
		chatEnabled.value = false;
		expect(mountPanel().find('[data-testid="thread-discussion"]').exists()).toBe(false);
	});
});

describe('PostboxThreadDiscussionToggle', () => {
	it('shows the count and hides the panel it controls', async () => {
		discussionData.value = { roomId: 'room-1', messages: [], count: 3 };
		const toggle = mount(PostboxThreadDiscussionToggle, {
			props: { threadId: 'thread-1' },
			global: { plugins: [createTestI18n()], stubs },
		});
		const panel = mountPanel();
		const button = toggle.find('[data-testid="thread-discussion-toggle"]');
		expect(button.text()).toContain('Discuss');
		expect(button.text()).toContain('3');
		expect(button.attributes('aria-pressed')).toBe('true');

		await button.trigger('click');
		expect(button.attributes('aria-pressed')).toBe('false');
		expect(panel.find('[data-testid="thread-discussion"]').exists()).toBe(false);
	});
});
