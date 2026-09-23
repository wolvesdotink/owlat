// @vitest-environment happy-dom
/**
 * Today's answer card (#774): the line under the big number splits it by
 * source and ADDS UP to it; drafts ready and the time estimate sit on their
 * own line; every count is a digit. Mounted against the real `en` catalog so
 * the assertions are on the sentences a member reads.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { inject } from 'vue';
import TodayAnswerCard from '../TodayAnswerCard.vue';
import TodaySourceLink from '../TodaySourceLink.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	answerEffortParts,
	answerMinutes,
	answerSourceParts,
	type AnswerCounts,
} from '~/utils/todayAnswerSummary';

const { t } = createTestI18n().global;

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		formatCompactRelativeTime: () => '1m',
		inject,
	});
});
const say = (parts: { key: string; count: number }[]) =>
	parts.map((p) => t(p.key, { count: p.count }, p.count)).join(' · ');

describe('answer summary', () => {
	const counts: AnswerCounts = { mail: 3, team: 1, mention: 1, drafts: 2 };

	it('splits the total by source, and the parts add up', () => {
		const parts = answerSourceParts(counts);
		expect(parts.reduce((sum, p) => sum + p.count, 0)).toBe(5);
		expect(say(parts)).toBe('3 in your inboxes · 1 in the team inbox · 1 mention');
	});

	it('puts drafts ready and the time estimate on the second line', () => {
		expect(say(answerEffortParts(counts, 5))).toBe('2 drafts ready · about 8 minutes');
		expect(say(answerEffortParts({ ...counts, drafts: 0 }, 1))).toBe('about 2 minutes');
		expect(say(answerEffortParts({ ...counts, drafts: 1 }, 0))).toBe(
			'1 draft ready · about 1 minute'
		);
	});

	it('leaves empty sources out', () => {
		expect(say(answerSourceParts({ mail: 0, team: 0, mention: 2, drafts: 0 }))).toBe('2 mentions');
	});

	it('never estimates less than a minute', () => {
		expect(answerMinutes(0)).toBe(1);
		expect(answerMinutes(4)).toBe(6);
	});
});

describe('TodayAnswerCard', () => {
	const item = (id: string) =>
		({
			id,
			source: 'mention',
			at: Date.now(),
			mention: { roomName: 'r', messagePreview: 'p' },
		}) as never;

	it('renders the number, the source line and the effort line with digits', () => {
		const w = mount(TodayAnswerCard, {
			props: {
				items: [item('a'), item('b')],
				counts: { mail: 1, team: 0, mention: 1, drafts: 1 },
				isLoading: false,
			},
			global: {
				plugins: [createTestI18n()],
				stubs: {
					UiButton: { template: '<a><slot /></a>' },
					UiSkeleton: true,
					Icon: true,
					InboxChip: true,
					NuxtLink: { template: '<a><slot /></a>' },
				},
			},
		});
		const text = w.text();
		expect(text).toContain('2 need an answer from you');
		expect(text).toContain('1 in your inboxes · 1 mention');
		expect(text).toContain('1 draft ready · about 3 minutes');
		expect(text).not.toMatch(/\bone\b/);
	});
});

describe('TodaySourceLink', () => {
	it('shows the phrase with no initials or count marker after it', () => {
		const w = mount(TodaySourceLink, {
			props: {
				text: 'Nora asked about the invoice',
				sources: [
					{
						kind: 'mail',
						id: 's1',
						threadId: 't1',
						fromName: 'Nora Fischer',
						fromAddress: 'nora@example.com',
						subject: 'Invoice',
						at: Date.now(),
					},
				] as never,
			},
			global: { plugins: [createTestI18n()] },
		});
		expect(w.text()).toBe('Nora asked about the invoice');
		expect(w.find('a').attributes('aria-label')).toContain('Nora Fischer');
	});
});
