// @vitest-environment happy-dom
/**
 * PostboxReplyGuard — one-time-per-thread confirm before replying to a sender in
 * one of the shapes a reply walks into (Sealed Mail A3, widened by UX plan idea
 * 56 from "failed DMARC" to the misaligned / look-alike / Reply-To-redirect
 * shapes that business email compromise actually uses).
 *
 * Covers:
 *   - a flagged sender shows the interstitial, lists every reason, and names the
 *     address the reply would actually be addressed to; confirming runs the reply;
 *   - the confirm is asked only ONCE per thread — a second reply on the same
 *     thread runs immediately with no interstitial;
 *   - a null risk (ordinary sender, or the flag off) never shows the interstitial;
 *   - cancel drops the pending reply without running it.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import PostboxReplyGuard from '../PostboxReplyGuard.vue';
import { deriveReplyRisk, type ReplyRisk } from '~/utils/senderAuth';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span />' };
const modalStub = {
	props: ['open', 'title', 'size'],
	template: '<div v-if="open" data-testid="modal"><slot /></div>',
};

type GuardVm = {
	guard: (
		threadId: string,
		risk: ReplyRisk | null,
		destination: string,
		action: () => void
	) => void;
};

/** A real derivation rather than a hand-built object, so the shapes can't drift. */
const FAILED = deriveReplyRisk({ auth: { fromDomain: 'acme.com', dmarcResult: 'fail' } });

function mountGuard() {
	const wrapper = mount(PostboxReplyGuard, {
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub, UiModal: modalStub },
		},
	});
	return { wrapper, vm: wrapper.vm as unknown as GuardVm };
}

describe('PostboxReplyGuard', () => {
	it('shows the interstitial for a flagged sender and runs the reply on confirm', async () => {
		const { wrapper, vm } = mountGuard();
		const reply = vi.fn();

		vm.guard('thread-1', FAILED, 'billing@acme.com', reply);
		await nextTick();
		// Interstitial shown; reply not yet sent.
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(true);
		expect(reply).not.toHaveBeenCalled();

		await wrapper.find('[data-testid="reply-guard-confirm"]').trigger('click');
		expect(reply).toHaveBeenCalledTimes(1);
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
	});

	it('names the destination address and every reason it has', async () => {
		const { wrapper, vm } = mountGuard();
		const risk = deriveReplyRisk({
			auth: { fromDomain: 'brightpath-finance.co', dmarcResult: 'fail' },
			heuristics: { lookalikeOfContactDomain: 'brightpath.com', isReplyToMismatch: true },
		});

		vm.guard('thread-1', risk, 'billing@brightpath-finance.co', vi.fn());
		await nextTick();

		const reasons = wrapper.findAll('[data-testid="reply-guard-reasons"] li');
		expect(reasons).toHaveLength(3);
		expect(reasons[1]!.text()).toContain('brightpath.com');
		expect(reasons[2]!.text()).toContain('asks for replies at a different domain');
		expect(wrapper.find('[data-testid="reply-guard-destination"]').text()).toContain(
			'billing@brightpath-finance.co'
		);
	});

	it('fires on a Reply-To redirect alone — the shape the old guard missed', async () => {
		const { wrapper, vm } = mountGuard();
		const reply = vi.fn();
		const risk = deriveReplyRisk({
			auth: {
				fromDomain: 'acme.com',
				dmarcResult: 'pass',
				spfResult: 'pass',
				envelopeFromDomain: 'acme.com',
			},
			heuristics: { isReplyToMismatch: true },
		});

		vm.guard('thread-1', risk, 'ceo@acme.com', reply);
		await nextTick();
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(true);
		expect(reply).not.toHaveBeenCalled();
	});

	it('asks only once per thread — the second reply proceeds with no interstitial', async () => {
		const { wrapper, vm } = mountGuard();

		const first = vi.fn();
		vm.guard('thread-1', FAILED, 'billing@acme.com', first);
		await nextTick();
		await wrapper.find('[data-testid="reply-guard-confirm"]').trigger('click');
		expect(first).toHaveBeenCalledTimes(1);

		const second = vi.fn();
		vm.guard('thread-1', FAILED, 'billing@acme.com', second);
		await nextTick();
		// No second prompt; the reply ran straight away.
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('never interstitials an ordinary sender (or a flag-off null risk)', async () => {
		const { wrapper, vm } = mountGuard();
		const verified = vi.fn();
		vm.guard('thread-1', null, 'hello@acme.com', verified);
		await nextTick();
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		expect(verified).toHaveBeenCalledTimes(1);
	});

	it('cancel drops the pending reply without running it', async () => {
		const { wrapper, vm } = mountGuard();
		const reply = vi.fn();
		vm.guard('thread-1', FAILED, 'billing@acme.com', reply);
		await nextTick();
		await wrapper.find('[data-testid="reply-guard-cancel"]').trigger('click');
		expect(reply).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
	});
});
