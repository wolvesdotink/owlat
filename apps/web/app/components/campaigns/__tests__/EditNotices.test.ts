/**
 * The campaign editor's notices for a scheduled start that did not happen. The
 * seed has no such campaign, so this suite is the proof of the state: the
 * campaign is a draft again, and the editor says why in place, from the
 * catalog, with a link to the page that fixes it. That every key is worded in
 * both languages is `~/lib/__tests__/campaignRefusal`'s check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import EditNotices from '../edit/EditNotices.vue';
import SendBlockedNote from '~/components/campaigns/SendBlockedNote.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { StoredStartRefusal } from '~/lib/campaignRefusal';
import type { StoredStartHold } from '~/utils/campaignStartHold';

Object.assign(globalThis, i18nStubs);

let isAdmin = true;

beforeEach(() => {
	isAdmin = true;
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(isAdmin) }));
});

const SCHEDULED_AT = Date.UTC(2026, 10, 2, 9, 0);

function mountNotices(startRefusal: StoredStartRefusal | null) {
	return mount(EditNotices, {
		props: {
			saveError: null,
			isScheduled: false,
			scheduledAtDisplay: '',
			isSaving: false,
			startRefusal,
		},
		global: {
			plugins: [createTestI18n()],
			components: { CampaignsSendBlockedNote: SendBlockedNote },
			stubs: { NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' } },
		},
	});
}

const portBlocked: StoredStartRefusal = {
	reason: 'mail_server_not_ready',
	messageKey: 'shared.campaignRefusal.mailServerPort25Blocked',
	message: 'Cannot send campaign: port 25 is blocked.',
	scheduledAt: SCHEDULED_AT,
};

describe('EditNotices — a scheduled start that did not happen', () => {
	it('says nothing when the last start went ahead', () => {
		expect(mountNotices(null).find('[data-testid="start-refused-notice"]').exists()).toBe(false);
	});

	it('names the reason from the catalog and links the page that fixes it', () => {
		const notice = mountNotices(portBlocked).find('[data-testid="start-refused-notice"]');
		expect(notice.text()).toContain('This campaign did not start');
		expect(notice.text()).toContain('port 25');
		expect(notice.find('[data-testid="send-blocked-fix"]').attributes('data-to')).toBe(
			'/dashboard/admin/delivery'
		);
	});

	it("shows the backend's sentence, without a link, for a reason this build does not know", () => {
		const notice = mountNotices({
			reason: 'some_future_reason',
			messageKey: 'shared.campaignRefusal.someFutureReason',
			message: 'Cannot send campaign: a reason from a newer backend.',
			scheduledAt: SCHEDULED_AT,
		}).find('[data-testid="start-refused-notice"]');
		expect(notice.text()).toContain('a reason from a newer backend');
		expect(notice.find('[data-testid="send-blocked-fix"]').exists()).toBe(false);
	});
});

describe('EditNotices — a scheduled start that is waiting', () => {
	const NOW = Date.UTC(2026, 10, 2, 10, 0);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function mountScheduled(startHold: StoredStartHold | null) {
		return mount(EditNotices, {
			props: {
				saveError: null,
				isScheduled: true,
				scheduledAt: SCHEDULED_AT,
				scheduledAtDisplay: 'Nov 2, 2026, 09:00',
				isSaving: false,
				startHold,
			},
			global: {
				plugins: [createTestI18n()],
				components: { CampaignsSendBlockedNote: SendBlockedNote },
				stubs: { UiButton: true },
			},
		});
	}

	it('says the start is waiting, why, and when the wait gives up, as a status', () => {
		const wrapper = mountScheduled({
			reason: 'delivery_on_hold',
			scheduledAt: SCHEDULED_AT,
			givesUpAt: SCHEDULED_AT + 6 * 60 * 60 * 1000,
		});
		const status = wrapper.find('[data-testid="start-waiting"]');
		expect(status.attributes('role')).toBe('status');
		expect(status.text()).toContain('Waiting to start');
		expect(status.text()).toContain('sending safety circuit is open');
		expect(status.text()).toContain('in 5 hours');
		// The start time is past: the notice no longer says it is still to come.
		expect(wrapper.text()).not.toContain('Nov 2, 2026, 09:00');
	});

	it('names a mail server that cannot deliver', () => {
		const wrapper = mountScheduled({
			reason: 'mail_server_not_ready',
			scheduledAt: SCHEDULED_AT,
			givesUpAt: SCHEDULED_AT + 6 * 60 * 60 * 1000,
		});
		expect(wrapper.find('[data-testid="start-waiting"]').text()).toContain(
			"The mail server can't deliver right now"
		);
	});

	it('keeps the status region empty for an ordinary scheduled start', () => {
		const wrapper = mountScheduled(null);
		expect(wrapper.find('[data-testid="start-waiting"]').text()).toBe('');
		expect(wrapper.text()).not.toContain('Waiting to start');
	});

	it('ignores a wait recorded for an earlier start', () => {
		const wrapper = mountScheduled({
			reason: 'delivery_on_hold',
			scheduledAt: SCHEDULED_AT - 60_000,
			givesUpAt: SCHEDULED_AT + 6 * 60 * 60 * 1000,
		});
		expect(wrapper.text()).not.toContain('Waiting to start');
	});
});
