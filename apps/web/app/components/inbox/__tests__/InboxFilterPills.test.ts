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

function mountPills() {
	return mount(InboxFilterPills, {
		props: { modelValue: 'open', assignee: 'anyone', counts },
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
});
