// @vitest-environment happy-dom
/**
 * The Postbox undo-send toast. Its reversal used to await `cancelPendingSend`
 * before closing, with no busy guard and no `:disabled`, so a double click
 * cancelled the send twice and reopened the recovered draft twice. It now
 * claims the window first (useUndoWindow.runUndo) and the shared toast guards
 * the button.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

import PostboxUndoSendToast from '../PostboxUndoSendToast.vue';
import { usePostboxUndoSend } from '~/composables/postbox/usePostboxUndoSend';
import { isQueuedSendToken } from '~/composables/postbox/usePostboxOfflineOutbox';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const MAILBOX_ID = 'mbx_1' as Id<'mailboxes'>;

const stateBuckets = new Map<string, ReturnType<typeof ref>>();
const cancelRuns: unknown[] = [];
const opened: unknown[] = [];
const unqueued: string[] = [];
let releaseCancel: () => void = () => {};

beforeEach(() => {
	stateBuckets.clear();
	cancelRuns.length = 0;
	opened.length = 0;
	unqueued.length = 0;
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-03-10T09:00:00Z'));

	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxSettings', () => ({ sendSound: ref(false) }));
	vi.stubGlobal('useUiSound', () => ({ playSend: () => {} }));
	vi.stubGlobal('usePostboxUndoSend', usePostboxUndoSend);
	vi.stubGlobal('isQueuedSendToken', isQueuedSendToken);
	vi.stubGlobal('usePostboxComposerStack', () => ({ open: (spec: unknown) => opened.push(spec) }));
	vi.stubGlobal('usePostboxOfflineOutbox', () => ({
		undoQueuedSend: async (token: string) => {
			unqueued.push(token);
			return null;
		},
	}));
	vi.stubGlobal('useBackendOperation', () => ({
		run: (args: unknown) => {
			cancelRuns.push(args);
			return new Promise((resolve) => {
				releaseCancel = () => resolve({ ok: true, result: { ok: true, draftId: 'draft_1' } });
			});
		},
	}));
});

async function mountArmed(undoToken: string) {
	usePostboxUndoSend().arm({ undoToken, sendAt: Date.now() + 10_000, mailboxId: MAILBOX_ID });
	const wrapper = mount(PostboxUndoSendToast, {
		global: { plugins: [createTestI18n()], stubs: { Icon: true, teleport: true } },
	});
	await nextTick();
	return wrapper;
}

describe('PostboxUndoSendToast', () => {
	it('announces the countdown as a status', async () => {
		const wrapper = await mountArmed('tok_1');
		const status = wrapper.find('[role="status"]');
		expect(status.exists()).toBe(true);
		expect(status.text()).toContain('Sending… (10s)');
	});

	it('closes before the cancel resolves, and a double click cancels once', async () => {
		const wrapper = await mountArmed('tok_1');
		const button = wrapper.find('button').element as HTMLButtonElement;

		button.click();
		button.click();
		await nextTick();
		expect(cancelRuns).toEqual([{ undoToken: 'tok_1' }]);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);

		releaseCancel();
		await flushPromises();
		expect(opened).toEqual([{ mailboxId: MAILBOX_ID, draftId: 'draft_1' }]);
		// `undone` follows the reopen, so a host can adopt the reopened draft.
		expect(wrapper.emitted('undone')).toHaveLength(1);
		expect(wrapper.emitted('expired')).toBeUndefined();
	});

	it('un-queues an offline send on device instead of asking the server', async () => {
		const wrapper = await mountArmed('outbox:ns:item_1');
		expect(wrapper.text()).toContain("Queued — sends when you're back online (10s)");

		await wrapper.find('button').trigger('click');
		await flushPromises();
		expect(unqueued).toEqual(['outbox:ns:item_1']);
		expect(cancelRuns).toEqual([]);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
	});

	it('closes on its own once the window runs out', async () => {
		const wrapper = await mountArmed('tok_1');
		vi.advanceTimersByTime(10_000);
		await nextTick();
		expect(usePostboxUndoSend().state.value.visible).toBe(false);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		expect(cancelRuns).toEqual([]);
		// The desktop compose window closes on this.
		expect(wrapper.emitted('expired')).toHaveLength(1);
		expect(wrapper.emitted('undone')).toBeUndefined();
	});
});
