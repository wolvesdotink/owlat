// @vitest-environment happy-dom
/**
 * PostboxDailyBrief — the Today-view greeting card:
 *   - renders the serif greeting + template sentences with every concrete
 *     count as a LINK to its surface (Today anchor / Reply Queue / For-you)
 *   - a stale read triggers exactly ONE background refresh (keyed guard)
 *   - dismiss hides the card optimistically and persists server-side
 *   - fail-soft: no card / server-side dismissal renders nothing
 *
 * Convex wiring is stubbed at the composable seam (useConvexQuery/useConvex),
 * mirroring the PostboxTodayView test setup.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxDailyBrief from '../PostboxDailyBrief.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type BriefRead = {
	card: {
		localDay: string;
		generatedAt: number;
		counts: { newMail: number; drafted: number; questions: number; autoFiled: number };
	} | null;
	isStale: boolean;
	isDismissed: boolean;
} | null;

const briefRead = ref<BriefRead>(null);
const mutationMock = vi.fn().mockResolvedValue(null);

beforeAll(() => {
	vi.stubGlobal('useConvexQuery', () => ({ data: briefRead, isLoading: ref(false) }));
	vi.stubGlobal('useConvex', () => ({ mutation: mutationMock }));
});

beforeEach(() => {
	mutationMock.mockClear();
	briefRead.value = null;
});

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };

function mountBrief() {
	return mount(PostboxDailyBrief, {
		props: { mailboxId: 'mbx-1' as never },
		global: {
			components: { Icon: iconStub, NuxtLink: nuxtLinkStub },
			stubs: { transition: true },
		},
	});
}

function freshCard(
	counts: Partial<{ newMail: number; drafted: number; questions: number; autoFiled: number }> = {}
): NonNullable<BriefRead> {
	return {
		card: {
			localDay: '2026-07-07',
			generatedAt: Date.now(),
			counts: { newMail: 4, drafted: 3, questions: 2, autoFiled: 6, ...counts },
		},
		isStale: false,
		isDismissed: false,
	};
}

describe('PostboxDailyBrief', () => {
	it('renders the greeting and one link per concrete count', () => {
		briefRead.value = freshCard();
		const w = mountBrief();

		expect(w.text()).toContain('Good');
		expect(w.text()).toContain('4 new since this morning');
		expect(w.text()).toContain('2 questions need you');

		const hrefs = w.findAll('a').map((a) => a.attributes('href'));
		expect(hrefs).toEqual(['#postbox-today', '/dashboard/postbox/reply-queue', '#postbox-for-you']);
	});

	it('renders nothing when there is no card (fail-soft) or it was dismissed server-side', async () => {
		briefRead.value = null;
		const w = mountBrief();
		expect(w.find('[data-postbox-brief-slot]').exists()).toBe(false);

		briefRead.value = { ...freshCard(), isDismissed: true };
		await w.vm.$nextTick();
		expect(w.find('[data-postbox-brief-slot]').exists()).toBe(false);
	});

	it('triggers exactly one background refresh for a stale read', async () => {
		briefRead.value = { ...freshCard(), isStale: true };
		const w = mountBrief();
		await w.vm.$nextTick();
		expect(mutationMock).toHaveBeenCalledTimes(1);

		// The subscription re-emitting the same stale generation must not loop.
		briefRead.value = { ...freshCard(), isStale: true };
		await w.vm.$nextTick();
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	it('does not refresh while the card is fresh', async () => {
		briefRead.value = freshCard();
		const w = mountBrief();
		await w.vm.$nextTick();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	it('dismiss hides the card immediately and persists the dismissal', async () => {
		briefRead.value = freshCard();
		const w = mountBrief();
		expect(w.find('[data-postbox-brief-slot]').exists()).toBe(true);

		await w.find('button[aria-label="Hide the brief until tomorrow"]').trigger('click');

		expect(w.find('[data-postbox-brief-slot]').exists()).toBe(false);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		const [, args] = mutationMock.mock.calls[0]!;
		expect(args).toMatchObject({ mailboxId: 'mbx-1' });
		expect(typeof args.localDay).toBe('string');
	});
});
