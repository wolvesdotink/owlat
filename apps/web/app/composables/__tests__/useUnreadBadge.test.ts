/**
 * `useUnreadBadge` is the one place the app turns the unread peek into the
 * number every badge shows. These specs pin that it subscribes in every
 * runtime (the browser tab needs it, not only the desktop dock), that the
 * count honours the "count all mail" preference with the same rule the dock
 * always used, and that flipping the preference recounts without a new
 * delivery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

type Peek = { total: number; messages: Array<Record<string, unknown>> };

const unread = ref<Peek | undefined>(undefined);
const badgeNonPeople = ref(true);
const subscribedWith: unknown[] = [];

function message(id: string, category?: string): Record<string, unknown> {
	return {
		messageId: id,
		threadId: `t-${id}`,
		fromAddress: `${id}@example.com`,
		subject: id,
		receivedAt: 1,
		...(category ? { category } : {}),
	};
}

async function mountBadge() {
	const { useUnreadBadge } = await import('../useUnreadBadge');
	let badge!: ReturnType<typeof useUnreadBadge>;
	const wrapper = mount(
		defineComponent({
			setup() {
				badge = useUnreadBadge();
				return () => h('div');
			},
		})
	);
	return { badge, wrapper };
}

beforeEach(() => {
	vi.resetModules();
	unread.value = undefined;
	badgeNonPeople.value = true;
	subscribedWith.length = 0;
	vi.stubGlobal('usePostboxSettings', () => ({ badgeNonPeople }));
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: unknown) => {
		subscribedWith.push(typeof args === 'function' ? args() : args);
		return { data: unread };
	});
});

describe('useUnreadBadge', () => {
	it('subscribes unconditionally, so the browser gets a count too', async () => {
		const { wrapper } = await mountBadge();
		expect(subscribedWith).toEqual([{ limit: 5 }]);
		wrapper.unmount();
	});

	it('is null until the first delivery', async () => {
		const { badge, wrapper } = await mountBadge();
		expect(badge.count.value).toBeNull();

		unread.value = { total: 0, messages: [] };
		expect(badge.count.value).toBe(0);
		wrapper.unmount();
	});

	it('counts the exact total, beyond the peek window, when all mail counts', async () => {
		const { badge, wrapper } = await mountBadge();
		unread.value = {
			total: 42,
			messages: [message('a', 'person'), message('b', 'newsletter'), message('c')],
		};
		expect(badge.count.value).toBe(42);
		wrapper.unmount();
	});

	it('counts people and unclassified mail in the peek when non-people mail is opted out', async () => {
		badgeNonPeople.value = false;
		const { badge, wrapper } = await mountBadge();
		unread.value = {
			total: 42,
			messages: [
				message('a', 'person'),
				message('b', 'newsletter'),
				message('c'),
				message('d', 'notification'),
				message('e', 'person'),
			],
		};
		expect(badge.count.value).toBe(3);
		wrapper.unmount();
	});

	it('never counts more than the total', async () => {
		badgeNonPeople.value = false;
		const { badge, wrapper } = await mountBadge();
		unread.value = { total: 1, messages: [message('a', 'person'), message('b', 'person')] };
		expect(badge.count.value).toBe(1);
		wrapper.unmount();
	});

	it('recounts when the preference flips, without another delivery', async () => {
		const { badge, wrapper } = await mountBadge();
		unread.value = {
			total: 9,
			messages: [message('a', 'person'), message('b', 'newsletter')],
		};
		expect(badge.count.value).toBe(9);

		badgeNonPeople.value = false;
		expect(badge.count.value).toBe(1);

		badgeNonPeople.value = true;
		expect(badge.count.value).toBe(9);
		wrapper.unmount();
	});
});
