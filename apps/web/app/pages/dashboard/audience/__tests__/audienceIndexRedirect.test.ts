// @vitest-environment happy-dom
/**
 * /dashboard/audience keeps working after the overview went away (#787): it
 * forwards to the contact list and carries the query, so the old
 * `?action=add` links still open the add-contact form.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AudienceIndex from '../index.vue';

type Redirect = (to: { query: Record<string, string>; hash: string }) => unknown;

describe('audience index', () => {
	it('redirects to the contact list, keeping the query and hash', () => {
		const definePageMeta = vi.fn();
		vi.stubGlobal('definePageMeta', definePageMeta);
		mount(AudienceIndex);
		const meta = definePageMeta.mock.calls[0]?.[0] as { redirect: Redirect };
		expect(meta.redirect({ query: { action: 'add' }, hash: '#x' })).toEqual({
			path: '/dashboard/audience/contacts',
			query: { action: 'add' },
			hash: '#x',
		});
	});
});
