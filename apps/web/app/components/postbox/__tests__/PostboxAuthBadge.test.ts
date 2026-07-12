// @vitest-environment happy-dom
/**
 * PostboxAuthBadge — the honest sender-authentication badge (Sealed Mail A3,
 * flag `senderAuthBadges`).
 *
 * Covers:
 *   - each state renders its VERBATIM summary + detail copy;
 *   - verified starts quiet (detail collapsed) and expands on click; a
 *     warn/danger state starts expanded and collapses on click;
 *   - flag off (`enabled=false`) renders nothing;
 *   - a legacy row (no verdicts) renders nothing even with the flag on.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxAuthBadge from '../PostboxAuthBadge.vue';
import type { SenderAuthInput } from '~/utils/senderAuth';

const iconStub = { props: ['name'], template: '<span />' };

function mountBadge(auth: SenderAuthInput, enabled = true) {
	return mount(PostboxAuthBadge, {
		props: { enabled, auth },
		global: { stubs: { Icon: iconStub } },
	});
}

const VERIFIED: SenderAuthInput = {
	fromDomain: 'acme.com',
	spfResult: 'pass',
	dmarcResult: 'pass',
	envelopeFromDomain: 'acme.com',
};
const MISALIGNED: SenderAuthInput = {
	fromDomain: 'acme.com',
	spfResult: 'pass',
	envelopeFromDomain: 'sketchy.example',
};
const FAILED: SenderAuthInput = {
	fromDomain: 'acme.com',
	dmarcResult: 'fail',
	dmarcPolicy: 'reject',
};
const UNAUTH: SenderAuthInput = {
	fromDomain: 'acme.com',
	spfResult: 'none',
	dmarcResult: 'none',
};

describe('PostboxAuthBadge', () => {
	it('verified: quiet chip, verbatim summary, detail hidden until expanded', async () => {
		const wrapper = mountBadge(VERIFIED);
		expect(wrapper.find('[data-testid="auth-badge-summary"]').text()).toBe('Verified sender');
		// Quiet by default: detail collapsed.
		expect(wrapper.find('[data-testid="auth-badge-detail"]').exists()).toBe(false);
		await wrapper.find('[data-testid="auth-badge-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="auth-badge-detail"]').text()).toBe(
			'We confirmed this message really was sent for acme.com.'
		);
	});

	it("keeps the reader's manual expand across a fresh auth object of the same state", async () => {
		// The parent binds `:auth="senderAuthInput(msg)"`, a new object every
		// render. Expansion must key off the derived state, not object identity,
		// or an unrelated re-render would re-snap what the reader just toggled.
		const wrapper = mountBadge(VERIFIED);
		await wrapper.find('[data-testid="auth-badge-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="auth-badge-detail"]').exists()).toBe(true);

		// A new object, same verified state (as the live parent would produce).
		await wrapper.setProps({ auth: { ...VERIFIED } });
		expect(wrapper.find('[data-testid="auth-badge-detail"]').exists()).toBe(true);
	});

	it('misaligned: verbatim impersonation copy, starts expanded, collapses on click', async () => {
		const wrapper = mountBadge(MISALIGNED);
		expect(wrapper.find('[data-testid="auth-badge-summary"]').text()).toBe('Sender not authorized');
		expect(wrapper.find('[data-testid="auth-badge-detail"]').text()).toBe(
			'Sent by sketchy.example, which is not authorized to send for acme.com.'
		);
		await wrapper.find('[data-testid="auth-badge-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="auth-badge-detail"]').exists()).toBe(false);
	});

	it('failed: verbatim summary + detail, starts expanded', () => {
		const wrapper = mountBadge(FAILED);
		expect(wrapper.find('[data-testid="auth-badge-summary"]').text()).toBe('Failed sender check');
		expect(wrapper.find('[data-testid="auth-badge-detail"]').text()).toBe(
			"This message says it's from acme.com, but it failed that domain's authentication checks — and acme.com asks that such messages be rejected. Treat it as suspicious."
		);
	});

	it('unauthenticated: verbatim summary + detail', () => {
		const wrapper = mountBadge(UNAUTH);
		expect(wrapper.find('[data-testid="auth-badge-summary"]').text()).toBe('Unverified sender');
		expect(wrapper.find('[data-testid="auth-badge-detail"]').text()).toBe(
			"We couldn't confirm this message really came from acme.com."
		);
	});

	it('flag off renders nothing', () => {
		const wrapper = mountBadge(FAILED, false);
		expect(wrapper.find('[data-testid="auth-badge"]').exists()).toBe(false);
	});

	it('legacy row (no verdicts) renders nothing even with the flag on', () => {
		const wrapper = mountBadge({ fromDomain: 'acme.com' });
		expect(wrapper.find('[data-testid="auth-badge"]').exists()).toBe(false);
	});
});
