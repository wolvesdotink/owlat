/**
 * ContactsSuppressionNotice (UX piece c5) — the inline "why isn't this contact
 * getting mail?" answer shown at the top of a suppressed contact's profile.
 * Asserts:
 *   - the reason renders in plain language, per reason
 *   - the "Remove suppression?" action is gated on canManage (permission)
 *   - the action emits `remove` and disables while removing
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { SOFT_BOUNCE_SUPPRESSION_TTL_MS } from '@owlat/shared/softBounceSuppression';
import { mount } from '@vue/test-utils';

import SuppressionNotice from '../SuppressionNotice.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// The notice renders through vue-i18n, so it is mounted against the real `en`
// catalog and asserted on the sentences an operator reads.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

type Reason = 'bounced' | 'complained' | 'manual' | 'unengaged';

function mountNotice(props: {
	reason: Reason;
	bounceType?: 'hard' | 'soft';
	createdAt?: number;
	dateLabel?: string;
	canManage?: boolean;
	removing?: boolean;
}) {
	return mount(SuppressionNotice, {
		props: {
			dateLabel: 'Mar 3',
			canManage: true,
			removing: false,
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { UiDisclosure: { template: '<div><slot name="label" /><slot /></div>' } },
		},
	});
}

describe('ContactsSuppressionNotice', () => {
	it('states the contact is not receiving mail', () => {
		const wrapper = mountNotice({ reason: 'bounced' });
		expect(wrapper.text()).toContain('Not receiving mail');
	});

	/**
	 * THE HEADLINE IS PER-REASON, and `unengaged` is the reason it has to be.
	 * That row is a MARKETING-ONLY hygiene decision: the address still receives
	 * transactional mail, double-opt-in confirmations and 1:1 agent replies.
	 * Presenting it identically to a hard-bounce block would push the operator
	 * into a manual removal they do not need.
	 */
	it('says campaigns, not mail, for a marketing-only hygiene suppression', () => {
		const wrapper = mountNotice({ reason: 'unengaged' });
		expect(wrapper.text()).toContain('Not receiving campaigns');
		expect(wrapper.text()).not.toContain('Not receiving mail');
	});

	it('renders a plain-language phrase per reason (no jargon)', () => {
		expect(mountNotice({ reason: 'bounced' }).text()).toContain('bounced on Mar 3');
		expect(mountNotice({ reason: 'complained' }).text()).toContain('complained on Mar 3');
		expect(mountNotice({ reason: 'manual' }).text()).toContain('manually suppressed on Mar 3');
		expect(mountNotice({ reason: 'unengaged' }).text()).toContain(
			'paused on Mar 3 after months with no opens or clicks'
		);
	});

	it('offers the remove action when the viewer can manage contacts', () => {
		const wrapper = mountNotice({ reason: 'bounced', canManage: true });
		const button = wrapper.find('button');
		expect(button.exists()).toBe(true);
		expect(button.text()).toContain('Remove suppression');
	});

	it('hides the remove action when the viewer cannot manage contacts', () => {
		const wrapper = mountNotice({ reason: 'bounced', canManage: false });
		expect(wrapper.find('button').exists()).toBe(false);
	});

	it('emits remove when the action is clicked', async () => {
		const wrapper = mountNotice({ reason: 'bounced', canManage: true });
		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('remove')).toHaveLength(1);
	});

	it('disables the action and shows progress while removing', () => {
		const wrapper = mountNotice({ reason: 'bounced', canManage: true, removing: true });
		const button = wrapper.find('button');
		expect(button.attributes('disabled')).toBeDefined();
		expect(button.text()).toContain('Removing');
	});
});

/**
 * A soft bounce blocks only until its expiry, the rule every send path applies.
 * The row stays on the list after that, so the contact page must tell a lapsed
 * soft bounce from a live block instead of saying "Not receiving mail".
 */
describe('ContactsSuppressionNotice for a soft bounce', () => {
	const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);
	afterEach(() => {
		vi.useRealTimers();
	});

	it('says a live soft bounce blocks mail, in its own words', () => {
		vi.useFakeTimers({ now: NOW });
		const text = mountNotice({
			reason: 'bounced',
			bounceType: 'soft',
			createdAt: NOW - 1000,
		}).text();
		expect(text).toContain('Not receiving mail');
		expect(text).toContain('bounced temporarily on Mar 3');
	});

	it('says a lapsed soft bounce no longer blocks', () => {
		vi.useFakeTimers({ now: NOW });
		const text = mountNotice({
			reason: 'bounced',
			bounceType: 'soft',
			createdAt: NOW - SOFT_BOUNCE_SUPPRESSION_TTL_MS - 1000,
		}).text();
		expect(text).toContain('Suppression expired');
		expect(text).toContain('mail goes out again');
		expect(text).not.toContain('Not receiving mail');
	});

	it('never lapses a hard bounce, however old', () => {
		vi.useFakeTimers({ now: NOW });
		const text = mountNotice({
			reason: 'bounced',
			bounceType: 'hard',
			createdAt: NOW - 10 * SOFT_BOUNCE_SUPPRESSION_TTL_MS,
		}).text();
		expect(text).toContain('Not receiving mail');
		expect(text).not.toContain('Suppression expired');
	});
});
