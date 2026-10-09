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
import { email, item, reply, teamView, T0 } from '~/utils/__tests__/teamStreamFixtures';
import TeamThreadStream from '../TeamThreadStream.vue';
import { evidence } from '~/utils/__tests__/threadBriefFixtures';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useLocalized: () => (s: string) => s });
});

const Plain = defineComponent({ setup: () => () => h('span') });

function teamOf(entries: unknown[], hasEarlier = false, citedId = 'in_2') {
	const cited = item({ id: 'i_1', text: 'Refund', evidence: [evidence(citedId, 'a refund')] });
	return {
		memberName: (id: string) => (id === 'user_mika' ? 'Mika Brandt' : id),
		stream: { entries: ref(entries), hasEarlier: ref(hasEarlier), loadEarlier: vi.fn() },
		openItems: ref(teamView({ forTeam: [cited] })),
		viewerId: ref('me'),
		members: ref([]),
		noteCounts: ref(new Map()),
		act: vi.fn(),
		assign: vi.fn(),
	};
}

function mountPinned(team: ReturnType<typeof teamOf>, props: Record<string, unknown> = {}) {
	return mount(TeamPinnedItems, {
		props: { team: team as never, ...props },
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

describe('TeamPinnedItems, outgoing citations', () => {
	it('name the teammate who wrote the reply, never the customer it went to', () => {
		const sent = reply('s1', T0, {
			source: { kind: 'teamReply', id: 'send_1' as never },
			authorUserId: 'user_mika',
			toName: 'Ana Costa',
		});
		const w = mountPinned(teamOf([sent], false, 'send_1'));
		const marker = w.get('[data-testid="evidence-marker"]');
		expect(marker.text()).toBe('MB Oct 7');
		expect(marker.attributes('aria-label')).toContain('Mika Brandt');
		expect(marker.attributes('aria-label')).not.toContain('Ana Costa');
		w.unmount();
	});

	it('bring the cited reply into view in the stream', async () => {
		const sent = reply('s1', T0, {
			source: { kind: 'teamReply', id: 'send_1' as never },
			isAgent: true,
			authorUserId: undefined,
		});
		const team = teamOf([email('in_1', T0 - 1000), sent], false, 'send_1');
		const Host = defineComponent({
			setup: () => () =>
				h('div', [
					h(TeamPinnedItems, { team: team as never }),
					h(TeamThreadStream, {
						entries: team.stream.entries.value as never,
						memberName: team.memberName,
					}),
				]),
		});
		const w = mount(Host, {
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				components: {
					UiAvatar: Plain,
					UiButton: Plain,
					PostboxOverflowMenu: Plain,
					InboxAutoSendCountdown: Plain,
					InboxNoteComposer: Plain,
				},
				stubs: { Icon: true },
			},
		});
		const row = w.get('[data-testid="team-stream-reply"]');
		expect(row.attributes('data-message-id')).toBe('send_1');
		const scroll = vi.fn();
		(row.element as HTMLElement).scrollIntoView = scroll;
		expect(w.get('[data-testid="evidence-marker"]').attributes('aria-label')).toContain(
			'The agent'
		);
		await w.get('[data-testid="evidence-marker"]').trigger('click');
		await nextTick();
		expect(scroll).toHaveBeenCalled();
		w.unmount();
	});

	it('hand a shared mailbox citation to the reader and say when it is out of reach', async () => {
		const citeMessage = vi.fn();
		const w = mountPinned(teamOf([]), { citeMessage, citeUnreachable: true });
		await w.get('[data-testid="evidence-marker"]').trigger('click');
		expect(citeMessage).toHaveBeenCalledWith('in_2');
		expect(w.get('[data-testid="team-cite-unreachable"]').text()).toBe(
			"Couldn't load the cited email."
		);
		w.unmount();
	});
});
