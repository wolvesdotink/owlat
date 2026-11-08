/**
 * The Workbench's "What needs you" (TodayWork): every reply, request and task
 * as one list of cards. The answer summary splits the queue by source and adds
 * up; a card reads by the same privacy rules the Answer queue rows always had
 * (a team row leads with its action, a shared row never shows an AI summary,
 * a personal row reads like plain mail with the brief off). Mounted against
 * the real `en` catalog so the assertions are on the sentences a member reads.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { inject, ref } from 'vue';
import TodayWork from '../TodayWork.vue';
import TodaySourceLink from '../TodaySourceLink.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	answerEffortParts,
	answerMinutes,
	answerSourceParts,
	type AnswerCounts,
} from '~/utils/todayAnswerSummary';

const { t } = createTestI18n().global;

const teamTops = ref<unknown[]>([]);
// The viewer's "Show the brief above conversations" (isAutoSummarizeOn).
const isBriefShown = ref(true);
beforeAll(() => {
	Object.assign(globalThis, {
		usePostboxSettings: () => ({ autoSummarize: isBriefShown }),
		useI18n: i18nStubs.useI18n,
		formatCompactRelativeTime: () => '1m',
		inject,
		useConvexQuery: () => ({ data: teamTops }),
		useConvexQueryMap: () => new Map([['batch', { data: teamTops }]]),
		useInboxes: () => ({ byId: ref(new Map()), inboxes: ref([]) }),
		useToast: () => ({ showToast: () => {} }),
		useBackendOperation: () => ({ run: async () => ({ ok: true }) }),
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

const STUBS = {
	UiButton: { template: '<a><slot /></a>' },
	UiSkeleton: true,
	InboxChip: true,
	TaskCreatePopover: true,
	CompanyTaskList: {
		props: ['tasks'],
		template: '<ul><li v-for="t in tasks">{{ t.title }}</li></ul>',
	},
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};
function mountWork(props: Record<string, unknown>) {
	return mount(TodayWork, {
		props: { todo: [], tasks: [], queueHref: '/dashboard/answer?in=all', ...props },
		global: { plugins: [createTestI18n()], stubs: STUBS },
	});
}

describe('TodayWork', () => {
	const item = (id: string) =>
		({
			id,
			source: 'mention',
			at: Date.now(),
			mention: { roomName: 'r', messagePreview: 'p' },
		}) as never;

	it('offers to work through the replies, with drafts ready and the time it takes in digits', () => {
		const w = mountWork({
			answer: [item('a'), item('b')],
			counts: { mail: 1, team: 0, mention: 1, drafts: 1 },
			isLoading: false,
		});
		const button = w.find('[data-testid="today-work-queue"]').text();
		expect(button).toContain('Work through 2 replies');
		expect(button).toContain('1 draft ready · about 3 minutes');
		expect(w.text()).not.toMatch(/\bone\b/);
		expect(w.findAll('[data-testid="today-work-card"]')).toHaveLength(2);
	});

	it('says so when nothing needs you', () => {
		const w = mountWork({
			answer: [],
			counts: { mail: 0, team: 0, mention: 0, drafts: 0 },
			isLoading: false,
		});
		expect(w.text()).toContain('Nothing needs you right now');
		expect(w.find('[data-testid="today-work-queue"]').exists()).toBe(false);
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
		const w = mountWork({
			answer: [team],
			counts: { mail: 0, team: 1, mention: 0, drafts: 0 },
			isLoading: false,
		});
		const line = w.find('[data-testid="today-work-card"]').text();
		expect(line).toContain('Contract renewal');
		expect(line).toContain('Inès Weber');
		expect(line).not.toContain('=?utf-8?');
	});

	it("says a team row held on the agent's questions needs your input (#1343)", () => {
		const held = {
			id: 'team:m2',
			source: 'team',
			at: Date.now(),
			entry: {
				message: {
					_id: 'm2',
					subject: 'Order status',
					from: 'Lea Brandt <lea@example.com>',
					processingStatus: 'awaiting_clarification',
				},
			},
		} as never;
		const w = mountWork({
			answer: [held],
			counts: { mail: 0, team: 1, mention: 0, drafts: 0 },
			isLoading: false,
		});
		expect(w.text()).toContain('needs your input');
		expect(w.text()).not.toContain('draft ready');
	});

	it('leads a team row with its top open action, then the sender and the raw preview', () => {
		teamTops.value = [{ threadId: 't1', text: 'Refund €129.00 for order #4471', count: 2 }];
		const team = {
			id: 'team:m1',
			source: 'team',
			at: Date.now(),
			entry: {
				thread: { _id: 't1', lastPreview: 'The replacement arrived broken too.' },
				message: {
					_id: 'm1',
					subject: 'Order #4471 arrived damaged',
					from: 'Ana <ana@example.com>',
				},
			},
		} as never;
		const w = mountWork({
			answer: [team],
			counts: { mail: 0, team: 1, mention: 0, drafts: 0 },
			isLoading: false,
		});
		const line = w.find('[data-testid="today-work-card"]').text();
		expect(line).toContain('Refund €129.00 for order #4471');
		expect(line).toContain('+1 more');
		expect(line).toContain('Ana · “The replacement arrived broken too.”');
		teamTops.value = [];
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

describe('TodayWork · brief rows', () => {
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
		return mountWork({
			answer: items,
			counts: { mail: 1, team: 0, mention: 0, drafts: 0 },
			isLoading: false,
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

	it('shows the exact count of the other open items', () => {
		const text = mountRows([mail('personal', { briefTop: { ...top, forYou: 2000 } })]).text();
		expect(text).toContain('+1999 more');
	});

	it('shows no chip for a single open item', () => {
		const text = mountRows([mail('personal', { briefTop: { ...top, forYou: 1 } })]).text();
		expect(text).not.toContain('more');
	});

	it('a personal row reads like plain mail when the viewer turned the brief off', () => {
		isBriefShown.value = false;
		try {
			const text = mountRows([mail('personal', { briefTop: top })]).text();
			expect(text).toContain('Order #4471');
			expect(text).toContain('Ana Costa · “The replacement arrived with a cracked base too”');
			expect(text).not.toContain('Approve the revised quote');
			expect(text).not.toContain('Launch moved');
			expect(text).not.toContain('Ana wants a refund');
			expect(text).not.toContain('more');
		} finally {
			isBriefShown.value = true;
		}
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

describe('TodayWork · requests and tasks', () => {
	const request = (over: Record<string, unknown> = {}) => ({
		threadId: 't9',
		messageId: 'm9',
		itemId: 'i9',
		text: { en: 'Pay invoice #2041', de: 'Rechnung #2041 bezahlen' },
		count: 1,
		fromAddress: 'ben@acmecorp.example',
		fromName: 'Ben Ortiz',
		subject: 'Invoice #2041',
		lastMessageAt: Date.now(),
		mailboxId: 'mb1',
		...over,
	});
	const counts = { mail: 0, team: 0, mention: 0, drafts: 0 };

	it('leads a request with what it asks, names who and the company, and opens it on its Overview', () => {
		const w = mountWork({ answer: [], todo: [request()], counts, isLoading: false });
		const card = w.find('[data-testid="today-work-card"]');
		expect(card.find('[data-testid="today-work-title"]').text()).toBe('Pay invoice #2041');
		expect(card.find('[data-testid="today-work-detail"]').text()).toBe('Ben Ortiz · Invoice #2041');
		const company = card.find('[data-testid="today-work-company"]');
		expect(company.text()).toBe('Acmecorp');
		expect(company.attributes('href')).toBe('/dashboard/companies/acmecorp.example');
		expect(card.find('[data-testid="today-work-title"]').attributes('href')).toBe(
			'/dashboard/postbox/inbox/m9?mailbox=mb1&view=overview'
		);
	});

	it('reads a personal request like plain mail when the viewer turned the brief off', () => {
		isBriefShown.value = false;
		try {
			const w = mountWork({ answer: [], todo: [request({ count: 3 })], counts, isLoading: false });
			const card = w.find('[data-testid="today-work-card"]');
			expect(card.find('[data-testid="today-work-title"]').text()).toBe('Invoice #2041');
			expect(card.text()).not.toContain('Pay invoice');
			expect(card.text()).not.toContain('more');
		} finally {
			isBriefShown.value = true;
		}
	});

	it('says when more requests wait than it could read, and links the inbox', () => {
		const w = mountWork({
			answer: [],
			todo: [request()],
			counts,
			isLoading: false,
			isTruncated: true,
			moreHref: '/dashboard/postbox/all-inboxes?in=mb1',
		});
		const note = w.find('[data-testid="today-work-truncated"]');
		expect(note.text()).toContain('More requests are waiting than fit here.');
		expect(note.find('a').attributes('href')).toBe('/dashboard/postbox/all-inboxes?in=mb1');
	});

	it('rides a task on the card of the conversation it came from', () => {
		const task = {
			_id: 'task1',
			title: 'Send the corrected invoice',
			dueAt: null,
			createdAt: Date.now(),
			companyKey: null,
			source: { kind: 'mail', mailThreadId: 't9', mailboxId: 'mb1', canOpen: true, subject: null },
		};
		const w = mountWork({ answer: [], todo: [request()], tasks: [task], counts, isLoading: false });
		const cards = w.findAll('[data-testid="today-work-card"]');
		expect(cards).toHaveLength(1);
		expect(cards[0]!.text()).toContain('Send the corrected invoice');
	});
});
