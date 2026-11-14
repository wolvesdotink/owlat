/**
 * The notice a campaign shows while a suspension holds its mail, and after the
 * hold ended the send. It renders nothing for a campaign sending normally, says
 * the mail waits rather than fails, and sends an admin to the delivery hub where
 * the account status lives while a member is told to ask one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub } from '@vue/test-utils';
import { ref } from 'vue';

import CampaignSendHoldNotice from '../CampaignSendHoldNotice.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatDateTime } from '~/utils/formatters';

let isAdmin = true;

beforeEach(() => {
	isAdmin = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(isAdmin) }));
	vi.stubGlobal('formatDateTime', formatDateTime);
});

type Hold =
	| { kind: 'held'; status: 'suspended' | 'banned'; since?: number; holdDays: number }
	| { kind: 'stopped'; at: number; holdDays: number };

function render(hold: Hold | null | undefined) {
	return mount(CampaignSendHoldNotice, {
		props: { hold },
		global: {
			plugins: [createTestI18n()],
			stubs: { NuxtLink: RouterLinkStub },
		},
	});
}

const SINCE = Date.UTC(2026, 10, 12, 9, 0);

describe('CampaignSendHoldNotice', () => {
	it('renders nothing for a campaign that is not held', () => {
		expect(render(null).text()).toBe('');
		expect(render(undefined).text()).toBe('');
	});

	it('says a suspended campaign is on hold and resumes once sending is restored', () => {
		const wrapper = render({ kind: 'held', status: 'suspended', since: SINCE, holdDays: 4 });
		const text = wrapper.text();
		expect(text).toContain('Sending on hold');
		expect(text).toContain('go out once sending is restored');
		expect(text).toContain('after 4 days is not sent');
		expect(text).toContain(`On hold since ${formatDateTime(SINCE)}`);
		expect(wrapper.attributes('role')).toBe('status');
	});

	it('names a disabled workspace differently from a suspended one', () => {
		expect(render({ kind: 'held', status: 'banned', holdDays: 4 }).text()).toContain(
			'Sending is disabled for this workspace'
		);
	});

	it('leaves out the since line when only already-enqueued mail is waiting', () => {
		expect(render({ kind: 'held', status: 'suspended', holdDays: 4 }).text()).not.toContain(
			'On hold since'
		);
	});

	it('says the rest was not mailed once the hold ended the send', () => {
		const text = render({ kind: 'stopped', at: SINCE, holdDays: 4 }).text();
		expect(text).toContain('Sending stopped');
		expect(text).toContain('were not mailed');
	});

	it('links an admin to the delivery hub and tells a member to ask an admin', () => {
		const admin = render({ kind: 'held', status: 'suspended', holdDays: 4 });
		expect(admin.findComponent(RouterLinkStub).props('to')).toBe('/dashboard/admin/delivery');

		isAdmin = false;
		const member = render({ kind: 'held', status: 'suspended', holdDays: 4 });
		expect(member.findComponent(RouterLinkStub).exists()).toBe(false);
		expect(member.text()).toContain('Ask an admin of this workspace');
	});
});
