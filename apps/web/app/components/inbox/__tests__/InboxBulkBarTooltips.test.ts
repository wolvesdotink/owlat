/**
 * The Team Inbox bulk bar's verbs carry their names (and, while the list's
 * keys are live, their keys) in a UiTooltip rather than a native title.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { tooltipOf } from '~/__tests__/tooltip';
import { pushShortcutScope, resetShortcutScopes } from '~/utils/shortcutScope';
import InboxBulkBar from '../InboxBulkBar.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

afterEach(() => resetShortcutScopes());

function mountBar(options: { attachTo?: HTMLElement } = {}) {
	return mount(InboxBulkBar, {
		props: { count: 2, members: [], currentUserId: null, assignOpen: false },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				InboxAssignPopover: { template: '<div><slot name="trigger" /></div>' },
			},
		},
		...options,
	});
}

describe('inbox bulk bar tooltips', () => {
	it('puts each verb in a tooltip and no native title on any control', () => {
		const wrapper = mountBar();
		expect(tooltipOf(wrapper, wrapper.get('[data-testid="inbox-bulk-resolve"]'))).toBe('Resolve');
		expect(tooltipOf(wrapper, wrapper.get('[data-testid="inbox-bulk-snooze"]'))).toBe('Snooze');
		const clear = wrapper.get('[data-testid="inbox-bulk-clear"]');
		expect(tooltipOf(wrapper, clear)).toBe('Clear selection');
		expect(clear.attributes('aria-label')).toBe('Clear selection');
		expect(wrapper.findAll('[title]')).toHaveLength(0);
	});

	it("links a verb's tooltip as its description while the list's key shows in it", async () => {
		pushShortcutScope('inboxList');
		const wrapper = mountBar({ attachTo: document.body });
		const resolve = wrapper.get('[data-testid="inbox-bulk-resolve"]');
		(resolve.element as HTMLElement).focus();
		await nextTick();
		const bubble = document.querySelector('[role="tooltip"]');
		expect(bubble?.textContent).toBe('ResolveE');
		expect(resolve.attributes('aria-describedby')).toBe(bubble!.id);
		wrapper.unmount();
	});
});
