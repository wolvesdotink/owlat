// @vitest-environment happy-dom
/**
 * The bulk bar's Unsubscribe verb, and the two ways it can lie.
 *
 * It may only appear when the backend says the selection holds One-Click list
 * mail (a page-only newsletter has nothing this button can finish), and when it
 * runs it must carry the SELECTED message ids, not just the sender addresses —
 * the ids are what let the action reach mail outside the subscriptions panel's
 * inbox window, which is where a selection in Archive or Spam lives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxQuickActionsBar from '../PostboxQuickActionsBar.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const selectionSenders = ref<unknown>([]);
const selectedIds = ref<string[]>(['m1', 'm2']);
const runSpy = vi.fn(async () => ({
	ok: true as const,
	result: { results: [{ senderEmail: 'news@a.example', status: 'unsubscribed', archived: 12 }] },
}));
const clearSpy = vi.fn();
const showToast = vi.fn();

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
vi.stubGlobal('useConvexQuery', () => ({
	data: selectionSenders,
	error: ref(null),
	isLoading: ref(false),
}));
vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
vi.stubGlobal('useToast', () => ({ showToast }));
vi.stubGlobal('usePostboxBulkActions', () => ({
	ids: selectedIds,
	count: ref(selectedIds.value.length),
	clear: clearSpy,
	markRead: vi.fn(),
	star: vi.fn(),
	moveSelected: vi.fn(),
	archiveSelected: vi.fn(),
	trashSelected: vi.fn(),
	purgeSelected: vi.fn(),
	reportSpamSelected: vi.fn(),
	notSpamSelected: vi.fn(),
}));
vi.stubGlobal('usePostboxFolders', () => ({ folders: ref([]) }));
vi.stubGlobal('usePostboxLabels', () => ({ labels: ref([]), setOnMessage: vi.fn() }));

const stubs = {
	UiButton: {
		props: ['disabled', 'loading', 'title'],
		template: '<button :disabled="disabled" :title="title"><slot /></button>',
	},
	Icon: { props: ['name'], template: '<span />' },
	PostboxSnoozeDialog: true,
};

function mountBar() {
	return mount(PostboxQuickActionsBar, {
		props: { mailboxId: 'mb1' as never, folderRole: 'archive' },
		global: { plugins: [createTestI18n()], stubs },
	});
}

function unsubscribeButton(wrapper: ReturnType<typeof mountBar>) {
	return wrapper.findAll('button').find((b) => b.text().includes('Unsubscribe'));
}

beforeEach(() => {
	runSpy.mockClear();
	clearSpy.mockClear();
	showToast.mockClear();
	selectedIds.value = ['m1', 'm2'];
	selectionSenders.value = [];
	vi.stubGlobal('confirm', () => true);
});

describe('PostboxQuickActionsBar unsubscribe', () => {
	it('stays hidden when the selection holds nothing One-Click', () => {
		expect(unsubscribeButton(mountBar())).toBeUndefined();
	});

	it('sends the selected message ids alongside the senders', async () => {
		selectionSenders.value = [{ senderEmail: 'news@a.example', actionMessageId: 'm2' }];
		const w = mountBar();
		await unsubscribeButton(w)!.trigger('click');
		expect(runSpy).toHaveBeenCalledWith({
			mailboxId: 'mb1',
			senderEmails: ['news@a.example'],
			messageIds: ['m1', 'm2'],
		});
	});

	it('reports every line of the outcome, not just the headline', async () => {
		selectionSenders.value = [{ senderEmail: 'news@a.example', actionMessageId: 'm2' }];
		const w = mountBar();
		await unsubscribeButton(w)!.trigger('click');
		await Promise.resolve();
		const [message, tone] = showToast.mock.calls[0] ?? [];
		expect(message).toContain('Unsubscribed from 1 sender');
		expect(message).toContain('12 messages archived');
		expect(tone).toBe('success');
	});

	it('does nothing when the confirm is declined', async () => {
		vi.stubGlobal('confirm', () => false);
		selectionSenders.value = [{ senderEmail: 'news@a.example', actionMessageId: 'm2' }];
		const w = mountBar();
		await unsubscribeButton(w)!.trigger('click');
		expect(runSpy).not.toHaveBeenCalled();
	});
});
