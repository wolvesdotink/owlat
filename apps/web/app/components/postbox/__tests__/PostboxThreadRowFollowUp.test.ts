// @vitest-environment happy-dom
/**
 * The follow-up chip is a cancel button only where the list wires the cancel
 * (the flat list). The Sections and Bundled rows render it as a plain
 * indicator, so no row ever shows a button that does nothing.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadRowFollowUp from '../PostboxThreadRowFollowUp.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountChip(followUp: { remindAt: number; dueAt?: number }, cancelable: boolean) {
	return mount(PostboxThreadRowFollowUp, {
		props: { followUp: { ...followUp, watched: true }, cancelable },
		global: {
			plugins: [createTestI18n()],
			components: { Icon: { props: ['name'], template: '<span />' } },
		},
	});
}

describe('PostboxThreadRowFollowUp', () => {
	it('is a cancel button when the list handles the cancel', async () => {
		const w = mountChip({ remindAt: 1, dueAt: 2 }, true);
		const button = w.find('button');
		expect(button.exists()).toBe(true);
		await button.trigger('click');
		expect(w.emitted('cancel')).toHaveLength(1);
	});

	it('is a plain indicator otherwise, for both the due and the armed state', () => {
		const due = mountChip({ remindAt: 1, dueAt: 2 }, false);
		expect(due.find('button').exists()).toBe(false);
		expect(due.text()).toContain('No reply yet');

		const armed = mountChip({ remindAt: 1 }, false);
		expect(armed.find('button').exists()).toBe(false);
		const label = armed.find('[role="img"]').attributes('aria-label') ?? '';
		expect(label).toMatch(/^Reply reminder /);
		expect(label).not.toContain('cancel');
	});
});
