// @vitest-environment happy-dom
/**
 * PostboxReplyGuard — one-time-per-thread confirm before replying to a message
 * that FAILED sender authentication (Sealed Mail A3, flag `senderAuthBadges`).
 *
 * Covers:
 *   - a "failed" sender shows the interstitial; confirming runs the reply;
 *   - the confirm is asked only ONCE per thread — a second reply on the same
 *     thread runs immediately with no interstitial;
 *   - a non-failed (or null) state never shows the interstitial;
 *   - cancel drops the pending reply without running it.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import PostboxReplyGuard from '../PostboxReplyGuard.vue';
import type { SenderAuthState } from '~/utils/senderAuth';

const iconStub = { props: ['name'], template: '<span />' };
const modalStub = {
	props: ['open', 'title', 'size'],
	template: '<div v-if="open" data-testid="modal"><slot /></div>',
};

type GuardVm = {
	guard: (threadId: string, state: SenderAuthState | null, action: () => void) => void;
};

function mountGuard() {
	const wrapper = mount(PostboxReplyGuard, {
		global: { stubs: { Icon: iconStub, UiModal: modalStub } },
	});
	return { wrapper, vm: wrapper.vm as unknown as GuardVm };
}

describe('PostboxReplyGuard', () => {
	it('shows the interstitial for a failed sender and runs the reply on confirm', async () => {
		const { wrapper, vm } = mountGuard();
		const reply = vi.fn();

		vm.guard('thread-1', 'failed', reply);
		await nextTick();
		// Interstitial shown; reply not yet sent.
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(true);
		expect(reply).not.toHaveBeenCalled();

		await wrapper.find('[data-testid="reply-guard-confirm"]').trigger('click');
		expect(reply).toHaveBeenCalledTimes(1);
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
	});

	it('asks only once per thread — the second reply proceeds with no interstitial', async () => {
		const { wrapper, vm } = mountGuard();

		const first = vi.fn();
		vm.guard('thread-1', 'failed', first);
		await nextTick();
		await wrapper.find('[data-testid="reply-guard-confirm"]').trigger('click');
		expect(first).toHaveBeenCalledTimes(1);

		const second = vi.fn();
		vm.guard('thread-1', 'failed', second);
		await nextTick();
		// No second prompt; the reply ran straight away.
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('never interstitials a non-failed (or unknown) sender', async () => {
		const { wrapper, vm } = mountGuard();
		const verified = vi.fn();
		vm.guard('thread-1', 'verified', verified);
		await nextTick();
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		expect(verified).toHaveBeenCalledTimes(1);

		const legacy = vi.fn();
		vm.guard('thread-2', null, legacy);
		await nextTick();
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		expect(legacy).toHaveBeenCalledTimes(1);
	});

	it('cancel drops the pending reply without running it', async () => {
		const { wrapper, vm } = mountGuard();
		const reply = vi.fn();
		vm.guard('thread-1', 'failed', reply);
		await nextTick();
		await wrapper.find('[data-testid="reply-guard-cancel"]').trigger('click');
		expect(reply).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
	});
});
