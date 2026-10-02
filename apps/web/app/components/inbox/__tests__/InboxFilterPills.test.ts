import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import InboxFilterPills from '../InboxFilterPills.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/**
 * #780 — four status tabs (Open / Waiting / Snoozed / Resolved) and a separate
 * assignment filter (Anyone / Me / Unassigned), instead of seven pills mixing
 * the two with a tab that was a subset of another.
 */
const counts = { open: 4, waiting: 2, snoozed: 1, resolved: 120, waitingOver24h: 1, cap: 100 };

function mountPills(extra: Record<string, unknown> = {}) {
	return mount(InboxFilterPills, {
		props: { modelValue: 'open', assignee: 'anyone', counts, ...extra },
		global: { plugins: [createTestI18n()] },
	});
}

describe('InboxFilterPills', () => {
	it('renders exactly the four status tabs with their counts', () => {
		const wrapper = mountPills();
		const tabs = wrapper.get('[role="group"]').findAll('button');
		expect(tabs.map((b) => b.text())).toEqual(['Open4', 'Waiting2', 'Snoozed1', 'Resolved99+']);
		expect(wrapper.text()).not.toContain('Mine');
		expect(wrapper.text()).not.toContain('24h');
	});

	it('keeps assignment as its own control and emits the pick', async () => {
		const wrapper = mountPills();
		const assignee = wrapper.get('[data-testid="inbox-assignee-filter"]');
		expect(assignee.findAll('button').map((b) => b.text())).toEqual(['Anyone', 'Me', 'Unassigned']);
		await assignee.findAll('button')[1]!.trigger('click');
		expect(wrapper.emitted('update:assignee')?.[0]).toEqual(['me']);
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('hides the response-target pills while targets are off', () => {
		const wrapper = mountPills({ sla: { isEnabled: false, overdue: 0, dueSoon: 0, cap: 100 } });
		expect(wrapper.find('[data-testid="inbox-sla-filters"]').exists()).toBe(false);
	});

	it('offers Overdue and Due soon with counts while targets are on', async () => {
		const wrapper = mountPills({ sla: { isEnabled: true, overdue: 3, dueSoon: 100, cap: 100 } });
		const pills = wrapper.get('[data-testid="inbox-sla-filters"]').findAll('button');
		expect(pills.map((b) => b.text())).toEqual(['Overdue3', 'Due soon99+']);
		await pills[0]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['sla-overdue']);
	});

	it('leaves Mentions for an Overdue / Due soon pick, and presses neither while it is on', async () => {
		const wrapper = mountPills({
			modelValue: 'sla-overdue',
			mentions: true,
			sla: { isEnabled: true, overdue: 3, dueSoon: 0, cap: 100 },
		});
		const pills = wrapper.get('[data-testid="inbox-sla-filters"]').findAll('button');
		expect(pills.every((pill) => pill.attributes('aria-pressed') === 'false')).toBe(true);
		await pills[1]!.trigger('click');
		expect(wrapper.emitted('update:mentions')?.[0]).toEqual([false]);
		expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['sla-due-soon']);
	});

	it('offers Mentions with the unread count, as a view of its own', async () => {
		const wrapper = mountPills({ unreadMentions: 2 });
		const pill = wrapper.get('[data-testid="inbox-mentions-filter"]');
		expect(pill.text()).toBe('Mentions2');
		await pill.trigger('click');
		expect(wrapper.emitted('update:mentions')?.[0]).toEqual([true]);
	});

	it('while Mentions is on, presses no tab, hides assignment, and a tab leaves it', async () => {
		const wrapper = mountPills({ mentions: true });
		const tabs = wrapper.get('[role="group"]').findAll('button');
		expect(tabs.every((tab) => tab.attributes('aria-pressed') === 'false')).toBe(true);
		expect(wrapper.find('[data-testid="inbox-assignee-filter"]').exists()).toBe(false);
		await tabs[1]!.trigger('click');
		expect(wrapper.emitted('update:mentions')?.[0]).toEqual([false]);
		expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['waiting']);
	});
});
