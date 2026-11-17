/**
 * A campaign list row's meta line for a scheduled campaign the start gate is
 * holding past its start time: it says the start is waiting, why, and when the
 * wait gives up, in a status region so the change is announced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { ClockIcon } from '@coolicons/vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatCompactRelativeTime, formatDate, formatDateTime } from '~/utils/formatters';
import type { DecoratedRow } from '~/utils/campaignCommandRow';
import CommandRow from '../CommandRow.vue';

import en from '~~/i18n/locales/en.json';

const SCHEDULED_AT = Date.UTC(2026, 10, 2, 9, 0);
const isAdmin = ref(true);
const NOW = SCHEDULED_AT + 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	Object.assign(globalThis, {
		...i18nStubs,
		formatDate,
		formatDateTime,
		formatCompactRelativeTime,
		usePermissions: () => ({ isAdmin }),
	});
	isAdmin.value = true;
});

afterEach(() => {
	vi.useRealTimers();
});

function row(campaign: Partial<DecoratedRow['campaign']>): DecoratedRow {
	return {
		campaign: {
			_id: 'cmp_1',
			name: 'Weekly digest',
			subject: 'This week',
			status: 'scheduled',
			scheduledAt: SCHEDULED_AT,
			updatedAt: SCHEDULED_AT,
			...campaign,
		} as DecoratedRow['campaign'],
		needsAttention: false,
		reason: null,
		reasonChip: null,
		statusBadge: { color: '', icon: ClockIcon, label: 'Scheduled' },
		actionLabel: null,
		openRate: null,
		clickRate: null,
		variantA: null,
		variantB: null,
		spark: [],
	};
}

function mountRow(value: DecoratedRow) {
	return mount(CommandRow, {
		props: { row: value },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiContextMenu: {
					template: '<div><slot :onContextmenu="() => {}" :onKeydown="() => {}" /></div>',
				},
				UiTooltip: { template: '<div><slot /></div>' },
				UiButton: {
					props: ['to'],
					emits: ['click'],
					template: '<button :data-to="to" @click="$emit(\'click\')"><slot /></button>',
				},
				UiDropdownMenu: true,
				UiDropdownMenuItem: true,
				UiDropdownDivider: true,
				UiSparkline: true,
			},
		},
	});
}

describe('campaign row meta line', () => {
	it('says a held start is waiting, why, and when it gives up, as a status', () => {
		const wrapper = mountRow(
			row({
				startHold: {
					reason: 'mail_server_not_ready',
					scheduledAt: SCHEDULED_AT,
					givesUpAt: SCHEDULED_AT + 6 * 60 * 60 * 1000,
				},
			})
		);
		const meta = wrapper.find('[data-testid="campaign-row-meta"]');
		expect(meta.attributes('role')).toBe('status');
		expect(meta.text()).toBe(
			"Waiting to start: the mail server can't deliver · gives up in 5 hours"
		);
	});

	it('keeps the scheduled time for a start that is not held', () => {
		const meta = mountRow(row({})).find('[data-testid="campaign-row-meta"]');
		expect(meta.text()).toBe(`Scheduled for ${formatDateTime(SCHEDULED_AT)}`);
	});
});

/**
 * A draft the start gate returned because its scheduled start was refused: the
 * row says why, with the stored reason, and an admin gets the same fix link the
 * editor's in-place note offers. A member, who cannot open that admin page,
 * gets the Review action instead.
 */
describe('a refused scheduled start', () => {
	const refused = (): DecoratedRow => ({
		...row({
			status: 'draft',
			scheduledAt: undefined,
			startRefusal: {
				reason: 'mail_server_not_ready',
				messageKey: 'shared.campaignRefusal.mailServerUnreachable',
				message: 'The mail server is down.',
				scheduledAt: SCHEDULED_AT,
				refusedAt: SCHEDULED_AT,
			},
		}),
		needsAttention: true,
		reason: 'start_refused',
		reasonChip: { label: 'shared.campaignAttention.start_refused.chip', dot: 'bg-warning' },
		actionLabel: 'shared.campaignAttention.start_refused.action',
	});

	it('shows the stored reason and the fix link to an admin', () => {
		const wrapper = mountRow(refused());
		expect(wrapper.text()).toContain("Didn't start");
		expect(wrapper.find('[data-testid="campaign-row-meta"]').text()).toBe(
			en.shared.campaignRefusal.mailServerUnreachable
		);
		const fix = wrapper.find('[data-testid="campaign-row-refusal-fix"]');
		expect(fix.attributes('data-to')).toBe('/dashboard/admin/delivery');
		expect(fix.text()).toBe(en.shared.campaignRefusal.fix.deliveryHub);
	});

	it('gives a member the Review action instead of an admin link', async () => {
		isAdmin.value = false;
		const wrapper = mountRow(refused());
		expect(wrapper.find('[data-testid="campaign-row-refusal-fix"]').exists()).toBe(false);
		const review = wrapper.findAll('button').find((b) => b.text() === 'Review');
		expect(review).toBeDefined();
		await review!.trigger('click');
		expect(wrapper.emitted('runAction')).toHaveLength(1);
	});
});
