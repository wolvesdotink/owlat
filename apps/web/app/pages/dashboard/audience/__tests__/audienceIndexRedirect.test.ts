// @vitest-environment happy-dom
/**
 * /dashboard/audience keeps working after the overview went away (#787): it
 * forwards to the contact list and carries the query, so the old
 * `?action=add` links still open the add-contact form.
 */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, Suspense } from 'vue';

import AudienceIndex from '../index.vue';
import { installNuxtStubs } from '~/__tests__/a11y';

describe('audience index', () => {
	it('redirects to the contact list, keeping the query', async () => {
		const navigateTo = vi.fn(async () => {});
		installNuxtStubs({
			navigateTo,
			useRoute: () => ({ path: '/dashboard/audience', query: { action: 'add' }, hash: '' }),
		});
		mount(
			defineComponent({ render: () => h(Suspense, null, { default: () => h(AudienceIndex) }) })
		);
		await flushPromises();
		expect(navigateTo).toHaveBeenCalledWith(
			{ path: '/dashboard/audience/contacts', query: { action: 'add' }, hash: '' },
			{ replace: true }
		);
	});
});
