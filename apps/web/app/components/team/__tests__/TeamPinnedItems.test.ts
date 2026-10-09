// @vitest-environment happy-dom
/**
 * Source markers on a team surface (review round 3, F2): the marker names who
 * sent the cited email and when (from the stream), and a click brings that
 * email into view in the stream, loading older pages until it is there.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import TeamPinnedItems from '../TeamPinnedItems.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { email, item, teamView, T0 } from '~/utils/__tests__/teamStreamFixtures';
import { evidence } from '~/utils/__tests__/threadBriefFixtures';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useLocalized: () => (s: string) => s });
});

const Plain = defineComponent({ setup: () => () => h('span') });

function teamOf(entries: unknown[], hasEarlier = false) {
	const cited = item({ id: 'i_1', text: 'Refund', evidence: [evidence('in_2', 'a refund')] });
	return {
		stream: { entries: ref(entries), hasEarlier: ref(hasEarlier), loadEarlier: vi.fn() },
		openItems: ref(teamView({ forTeam: [cited] })),
		viewerId: ref('me'),
		members: ref([]),
		noteCounts: ref(new Map()),
		act: vi.fn(),
		assign: vi.fn(),
	};
}

function mountPinned(team: ReturnType<typeof teamOf>) {
	return mount(TeamPinnedItems, {
		props: { team: team as never },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiAvatar: Plain, UiButton: Plain, PostboxOverflowMenu: Plain },
			stubs: { Icon: true },
		},
	});
}

describe('TeamPinnedItems source markers', () => {
	it('name the sender and date, and bring the cited email into view', async () => {
		const target = document.createElement('article');
		target.dataset['messageId'] = 'in_2';
		target.scrollIntoView = vi.fn();
		document.body.append(target);
		const w = mountPinned(teamOf([email('in_2', T0)]));
		const marker = w.get('[data-testid="evidence-marker"]');
		expect(marker.text()).toBe('AC Oct 7');
		await marker.trigger('click');
		await nextTick();
		expect(target.scrollIntoView).toHaveBeenCalled();
		expect(target.classList.contains('ring-2')).toBe(true);
		target.remove();
		w.unmount();
	});

	it('load older stream pages until the cited email is there', async () => {
		const team = teamOf([], true);
		const w = mountPinned(team);
		await w.get('[data-testid="evidence-marker"]').trigger('click');
		await nextTick();
		expect(team.stream.loadEarlier).toHaveBeenCalledTimes(1);
		w.unmount();
	});
});
