/**
 * The Team Inbox bulk bar's verbs carry their names (and, while the list's
 * keys are live, their keys) in a UiTooltip rather than a native title.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { tooltipOf } from '~/__tests__/tooltip';
import InboxBulkBar from '../InboxBulkBar.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

describe('inbox bulk bar tooltips', () => {
	it('puts each verb in a tooltip and no native title on any control', () => {
		const wrapper = mount(InboxBulkBar, {
			props: { count: 2, members: [], currentUserId: null, assignOpen: false },
			global: {
				plugins: [createTestI18n()],
				stubs: {
					InboxAssignPopover: { template: '<div><slot name="trigger" /></div>' },
				},
			},
		});
		expect(tooltipOf(wrapper, wrapper.get('[data-testid="inbox-bulk-resolve"]'))).toBe('Resolve');
		expect(tooltipOf(wrapper, wrapper.get('[data-testid="inbox-bulk-snooze"]'))).toBe('Snooze');
		const clear = wrapper.get('[data-testid="inbox-bulk-clear"]');
		expect(tooltipOf(wrapper, clear)).toBe('Clear selection');
		expect(clear.attributes('aria-label')).toBe('Clear selection');
		expect(wrapper.findAll('[title]')).toHaveLength(0);
	});
});
