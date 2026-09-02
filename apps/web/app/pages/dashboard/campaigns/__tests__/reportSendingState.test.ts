// @vitest-environment happy-dom
/**
 * The campaign report BEFORE there is anything to report.
 *
 * Pressing send now lands here immediately (UX plan T3): the send is held one
 * undo window out, so for its first minute the campaign is `scheduled`, then
 * `sending`, and every stat is zero. The page used to hard-code "Sent {date}"
 * and a green "Sent" badge, which greeted a send that had not happened yet with
 * "Sent never" and a success tick — the two claims a live report must not make.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import type { FunctionReference } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';

import CampaignReport from '../[id]/report.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { formatDateTime, formatCompactRelativeTime } from '~/utils/formatters';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';

const CAMPAIGN_ID = 'campaign_1' as Id<'campaigns'>;
const SENT_AT = new Date('2026-03-10T09:00:00').getTime();
const SCHEDULED_AT = new Date('2026-03-10T09:01:00').getTime();

/** Nothing has been dispatched yet: every counter is a zero. */
const ZERO_STATS = {
	total: 0,
	queued: 0,
	failed: 0,
	delivered: 0,
	uniqueOpens: 0,
	uniqueClicks: 0,
	bounced: 0,
};

function mountReport(campaign: Record<string, unknown>) {
	installNuxtStubs({
		...i18nStubs,
		formatDateTime,
		formatCompactRelativeTime,
		useCopyToClipboard,
		useRouteId: () => ref(CAMPAIGN_ID),
		// Keyed by function NAME: the generated `api` object is a proxy that hands
		// back a fresh reference on every property access, so identity comparison
		// against `api.x.y` silently matches nothing.
		useConvexQuery: (reference: FunctionReference<'query'>) => {
			const name = getFunctionName(reference);
			if (name === 'campaigns/campaigns:getWithRelations') return queryResult(campaign);
			if (name === 'delivery/sends:getStatsByCampaign') return queryResult(ZERO_STATS);
			return queryResult(undefined);
		},
	});

	return mount(CampaignReport, {
		global: {
			plugins: [createTestI18n()],
			// Feature components are left unresolved on purpose (see the
			// add-contact picker suite); the warning storm would bury a real one.
			config: { warnHandler: () => {} },
		},
	});
}

beforeEach(() => {
	vi.useRealTimers();
});

describe('campaign report while the send is still pending', () => {
	it('says the campaign is scheduled, and when, instead of claiming it was sent', () => {
		const wrapper = mountReport({
			_id: CAMPAIGN_ID,
			name: 'Weekly digest #34',
			status: 'scheduled',
			scheduledAt: SCHEDULED_AT,
			isABTest: false,
		});

		const text = wrapper.text();
		expect(text).toContain('Scheduled');
		expect(text).toContain(`Sends ${formatDateTime(SCHEDULED_AT)}`);
		expect(text).not.toContain('Sent ');
		// A recipient count of zero before the first message goes out is not
		// information, and "Never" is not a send date.
		expect(text).not.toContain('0 recipients');
		expect(text).not.toContain('Never');
	});

	it('explains the zeros rather than comparing them to a previous send', () => {
		const wrapper = mountReport({
			_id: CAMPAIGN_ID,
			name: 'Weekly digest #34',
			status: 'scheduled',
			scheduledAt: SCHEDULED_AT,
			isABTest: false,
		});

		expect(wrapper.text()).toContain('These fill in as the send goes out.');
		expect(wrapper.text()).not.toContain('No comparable prior send');
	});

	it('reads as in-flight while sending', () => {
		const wrapper = mountReport({
			_id: CAMPAIGN_ID,
			name: 'Weekly digest #34',
			status: 'sending',
			sentAt: SENT_AT,
			isABTest: false,
		});

		const text = wrapper.text();
		expect(text).toContain('Sending');
		expect(text).toContain(`Sending since ${formatDateTime(SENT_AT)}`);
		// The send HAS started, so the dispatched count is real information again.
		expect(text).toContain('0 recipients');
	});

	it('keeps the finished report exactly as it was', () => {
		const wrapper = mountReport({
			_id: CAMPAIGN_ID,
			name: 'Weekly digest #34',
			status: 'sent',
			sentAt: SENT_AT,
			isABTest: false,
		});

		const text = wrapper.text();
		expect(text).toContain('Sent');
		expect(text).toContain(`Sent ${formatDateTime(SENT_AT)}`);
		expect(text).toContain('0 recipients');
		expect(text).not.toContain('These fill in as the send goes out.');
	});

	it('does not call a cancelled campaign sent', () => {
		const wrapper = mountReport({
			_id: CAMPAIGN_ID,
			name: 'Weekly digest #34',
			status: 'cancelled',
			isABTest: false,
		});

		const text = wrapper.text();
		expect(text).toContain('Cancelled');
		expect(text).toContain('Cancelled before it went out');
	});
});
