// @vitest-environment happy-dom
/**
 * ContactsSuppressionNotice (UX piece c5) — the inline "why isn't this contact
 * getting mail?" answer shown at the top of a suppressed contact's profile.
 * Asserts:
 *   - the reason renders in plain language, per reason
 *   - the "Remove suppression?" action is gated on canManage (permission)
 *   - the action emits `remove` and disables while removing
 * Icon is a global auto-import, stubbed here.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import SuppressionNotice from '../SuppressionNotice.vue';

type Reason = 'bounced' | 'complained' | 'manual';

function mountNotice(props: {
	reason: Reason;
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
		global: { stubs: { Icon: true } },
	});
}

describe('ContactsSuppressionNotice', () => {
	it('states the contact is not receiving mail', () => {
		const wrapper = mountNotice({ reason: 'bounced' });
		expect(wrapper.text()).toContain('Not receiving mail');
	});

	it('renders a plain-language phrase per reason (no jargon)', () => {
		expect(mountNotice({ reason: 'bounced' }).text()).toContain('bounced on Mar 3');
		expect(mountNotice({ reason: 'complained' }).text()).toContain('complained on Mar 3');
		expect(mountNotice({ reason: 'manual' }).text()).toContain('manually suppressed on Mar 3');
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
