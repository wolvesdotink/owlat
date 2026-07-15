// @vitest-environment happy-dom
/**
 * SenderAuthChip renders the honest From-identity authenticity chip:
 *   - a verified, aligned identity shows the plain "Sender verified" chip and no
 *     warning detail (it never claims more than was checked)
 *   - a misaligned transport shows the error chip AND the disable-with-reason
 *     detail (verbatim reason passthrough)
 *   - an unverified domain shows the "Domain not verified" chip + reason
 *   - an unknown (undeclared-relay) alignment is a soft caution, not a claimed
 *     failure
 * The copy is asserted verbatim — the badge/lock honesty audit is a test.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import SenderAuthChip from '../SenderAuthChip.vue';

const iconStub = { props: ['name'], template: '<span />' };

function mountChip(props: {
	verified: boolean;
	alignment: 'aligned' | 'misaligned' | 'unknown';
	reason?: string | null;
}) {
	return mount(SenderAuthChip, {
		props,
		global: { stubs: { Icon: iconStub } },
	});
}

describe('SenderAuthChip', () => {
	it('shows "Sender verified" with no warning detail when verified and aligned', () => {
		const wrapper = mountChip({ verified: true, alignment: 'aligned' });
		expect(wrapper.text()).toContain('Sender verified');
		expect(wrapper.text()).not.toContain('spam');
		// No detail paragraph when the identity is clean.
		expect(wrapper.find('p').exists()).toBe(false);
	});

	it('shows "Sender not aligned" and the verbatim reason for a misaligned transport', () => {
		const reason =
			'This transport signs and bounces mail as “sendgrid.net”, which isn’t part of “acme.com”.';
		const wrapper = mountChip({ verified: true, alignment: 'misaligned', reason });
		expect(wrapper.text()).toContain('Sender not aligned');
		expect(wrapper.text()).toContain(reason);
		expect(wrapper.find('p').exists()).toBe(true);
	});

	it('falls back to a default reason when a misaligned identity has none', () => {
		const wrapper = mountChip({ verified: true, alignment: 'misaligned' });
		expect(wrapper.text()).toContain('Sender not aligned');
		expect(wrapper.text()).toContain('mailboxes can treat it as spam');
	});

	it('shows "Domain not verified" and disables regardless of alignment', () => {
		const wrapper = mountChip({ verified: false, alignment: 'aligned' });
		expect(wrapper.text()).toContain('Domain not verified');
		expect(wrapper.text()).toContain('turned off');
	});

	it('shows a soft "Alignment unconfirmed" caution for an unknown relay identity', () => {
		const wrapper = mountChip({ verified: true, alignment: 'unknown' });
		expect(wrapper.text()).toContain('Alignment unconfirmed');
		expect(wrapper.text()).not.toContain('Sender not aligned');
	});
});
