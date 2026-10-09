// @vitest-environment happy-dom
/**
 * "With Jonas elsewhere" (plan §4.3): one section per person, each open item
 * linking to the thread it lives in (the Postbox reader by message, the Team
 * Inbox by thread), and nothing at all when the server lists nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, watchEffect } from 'vue';
import BriefElsewhere from '../BriefElsewhere.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const data = ref<unknown>(null);
const queriedWith = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: () => unknown) => {
		watchEffect(() => queriedWith(args()));
		return { data, isLoading: ref(false) };
	});
});

beforeEach(() => {
	data.value = null;
	queriedWith.mockReset();
});

const NuxtLink = defineComponent({
	props: { to: { type: String, required: true } },
	setup:
		(props, { slots }) =>
		() =>
			h('a', { href: props.to }, slots.default?.()),
});

function mountCard(threadRef: unknown = { kind: 'mail', id: 'th1' }) {
	return mount(BriefElsewhere, {
		props: { threadRef: threadRef as never },
		global: { plugins: [createTestI18n()], stubs: { NuxtLink } },
	});
}

describe('BriefElsewhere', () => {
	it('lists each person’s open items elsewhere with a link to their thread', async () => {
		data.value = {
			groups: [
				{
					counterpartyKey: 'jonas@example.com',
					name: 'Jonas',
					isMore: true,
					isPartial: false,
					items: [
						{
							itemId: 'i1',
							threadRef: { kind: 'mail', id: 'th2' },
							messageId: 'm9',
							mailboxId: 'mb1',
							subject: 'Framework agreement',
							text: 'Jonas sends the signed NDA',
							responsibility: 'them',
							dueAt: Date.UTC(2026, 9, 9),
						},
						{
							itemId: 'i2',
							threadRef: { kind: 'team', id: 'ct1' },
							subject: 'Order 42',
							text: 'Refund order 42',
							responsibility: 'us',
						},
					],
				},
			],
		};
		const w = mountCard();
		expect(queriedWith).toHaveBeenCalledWith({
			threadRef: { kind: 'mail', id: 'th1' },
			locale: 'en',
			limit: 5,
		});
		expect(w.text()).toContain('With Jonas elsewhere');
		expect(w.text()).toContain('Jonas sends the signed NDA');
		expect(w.text()).toContain('in “Framework agreement”');
		expect(w.text()).toContain('on their side');
		expect(w.text()).toContain('for you');
		// More readable items: "Show more" asks for them (F4).
		expect(w.text()).not.toContain('More open items with them in other conversations.');
		queriedWith.mockReset();
		await w.get('[data-testid="brief-elsewhere-more"]').trigger('click');
		await nextTick();
		expect(queriedWith).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 25 }));
		expect(w.find('[data-testid="brief-elsewhere-more"]').exists()).toBe(false);
		expect(w.text()).toContain('More open items with them in other conversations.');
		const hrefs = w.findAll('a').map((a) => a.attributes('href'));
		expect(hrefs).toEqual(['/dashboard/postbox/inbox/m9?mailbox=mb1', '/dashboard/inbox/ct1']);
		expectFullyLocalized(w);
	});

	it('says when the scan of the viewer’s own scopes stopped short', () => {
		data.value = {
			groups: [
				{
					counterpartyKey: 'ana@example.com',
					isMore: false,
					isPartial: true,
					items: [
						{
							itemId: 'i3',
							threadRef: { kind: 'team', id: 'ct2' },
							subject: 'Order 7',
							text: 'Refund order 7',
							responsibility: 'us',
						},
					],
				},
			],
		};
		const w = mountCard();
		expect(w.find('[data-testid="brief-elsewhere-more"]').exists()).toBe(false);
		expect(w.text()).toContain('More open items with them in other conversations.');
	});

	it('renders nothing when there is nothing elsewhere, and reads nothing without a thread', () => {
		data.value = { groups: [] };
		expect(mountCard().find('[data-testid="brief-elsewhere"]').exists()).toBe(false);
		queriedWith.mockReset();
		mountCard(null);
		expect(queriedWith).toHaveBeenCalledWith('skip');
	});
});
