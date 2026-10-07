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

	it('links to the whole queue when inboxes left out of Today hold more', () => {
		const w = mount(TodayAnswerCard, {
			props: {
				items: [item('a')],
				counts: { mail: 0, team: 0, mention: 1, drafts: 0 },
				isLoading: false,
				queueTotal: 6,
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
		expect(w.text()).toContain('1 needs an answer from you');
		expect(w.text()).toContain('All 6 in the queue');
	});

	it('shows a team row sender by its decoded display name', () => {
		const team = {
			id: 'team:m1',
			source: 'team',
			at: Date.now(),
			entry: {
				message: {
					_id: 'm1',
					subject: 'Contract renewal',
					from: '=?utf-8?B?SW7DqHMgV2ViZXI=?= <Ines@Example.COM>',
				},
			},
		} as never;
		const w = mount(TodayAnswerCard, {
			props: {
				items: [team],
				counts: { mail: 0, team: 1, mention: 0, drafts: 0 },
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
		const line = w.find('[data-today-line]').text();
		expect(line).toContain('Contract renewal');
		expect(line).toContain('Inès Weber');
		expect(line).not.toContain('=?utf-8?');
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

describe('TodayAnswerCard · brief rows (SPEC §7)', () => {
	const row = (over: Record<string, unknown>) => ({
		threadId: 't1',
		messageId: 'm1',
		urgency: 'normal',
		detectedAt: 1,
		source: 'llm',
		fromAddress: 'ana@example.com',
		fromName: 'Ana Costa',
		subject: 'Order #4471',
		snippet: 'The replacement arrived with a cracked base too',
		receivedAt: Date.now(),
		askSummary: 'Ana wants a refund for the cracked base',
		...over,
	});
	const mail = (scope: 'personal' | 'shared', over: Record<string, unknown> = {}) =>
		({
			id: 'mail:t1',
			source: 'mail',
			at: Date.now(),
			mailboxId: 'mb1',
			inbox: { scope },
			row: row(over),
		}) as never;
	function mountRows(items: never[]) {
		return mount(TodayAnswerCard, {
			props: { items, counts: { mail: 1, team: 0, mention: 0, drafts: 0 }, isLoading: false },
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
	}
	const top = {
		mode: 'brief',
		forYou: 4,
		waiting: 0,
		top: {
			itemId: 'i1',
			responsibility: 'us',
			text: { en: 'Approve the revised quote', de: 'Gib das Angebot frei' },
		},
		latest: { en: 'Launch moved to 14 Nov.', de: 'Launch verschoben.' },
		isReplyNeeded: true,
	};

	it('a personal row reads the top item, +N more, and the latest update', () => {
		const text = mountRows([mail('personal', { briefTop: top })]).text();
		expect(text).toContain('Approve the revised quote');
		expect(text).toContain('+3 more');
		expect(text).toContain('Ana Costa · Order #4471 · Launch moved to 14 Nov.');
		expect(text).not.toContain('Ana wants a refund');
	});

	it('shows a capped count as a lower bound, never as exact', () => {
		const capped = { ...top, forYou: 2000, isCapped: true };
		const text = mountRows([mail('personal', { briefTop: capped })]).text();
		expect(text).toContain('1999+ more');
		expect(text).not.toContain('+1999 more');
	});

	it('shows no chip for a single open item', () => {
		const text = mountRows([mail('personal', { briefTop: { ...top, forYou: 1 } })]).text();
		expect(text).not.toContain('more');
	});

	it('a shared row without an item never shows the AI ask summary', () => {
		const text = mountRows([mail('shared')]).text();
		expect(text).not.toContain('Ana wants a refund');
		expect(text).toContain('Order #4471');
		expect(text).toContain('Ana Costa · “The replacement arrived with a cracked base too”');
	});

	it('a shared row with an item shows it beside the raw preview, never a latest line', () => {
		const text = mountRows([
			mail('shared', { briefTop: { ...top, mode: 'actions', latest: undefined } }),
		]).text();
		expect(text).toContain('Approve the revised quote');
		expect(text).toContain('“The replacement arrived with a cracked base too”');
		expect(text).not.toContain('Launch moved');
	});
});
