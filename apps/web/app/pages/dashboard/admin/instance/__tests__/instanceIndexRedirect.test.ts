/**
 * /dashboard/admin/instance has no page of its own: the operating-mode card
 * lives at the top of Features, so the old URL forwards there and carries the
 * query and hash. Its sub-pages are separate routes and are not affected.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import InstanceIndex from '../index.vue';

type Redirect = (to: { query: Record<string, string>; hash: string }) => unknown;

describe('instance index', () => {
	it('redirects to Features, keeping the query and hash', () => {
		const definePageMeta = vi.fn();
		vi.stubGlobal('definePageMeta', definePageMeta);
		mount(InstanceIndex);
		const meta = definePageMeta.mock.calls[0]?.[0] as { redirect: Redirect };
		expect(meta.redirect({ query: { tab: 'x' }, hash: '#operating-mode' })).toEqual({
			path: '/dashboard/admin/instance/features',
			query: { tab: 'x' },
			hash: '#operating-mode',
		});
	});
});
