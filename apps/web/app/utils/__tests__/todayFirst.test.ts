/**
 * The pure rules behind Today, the Answer queue and the sidebar:
 *   - every inbox gets a stable colour slot (explicit first, then in order);
 *   - one status per row, the most urgent wins;
 *   - the Answer queue interleaves mail, team drafts and mentions on one scale;
 *   - Today sorts digests into changed / worth knowing / also arrived / filed,
 *     never drops a line silently, and asks the summarizer only for bare lines;
 *   - a peek link names its email and survives a round trip through the URL.
 */
import { describe, expect, it } from 'vitest';
import { nameFromAddress, resolveInboxIdentities } from '../inboxIdentity';
import {
	mailThreadStatus,
	mostUrgentConversationStatus,
	teamThreadStatus,
} from '../conversationStatus';
import { compareAnswerItems } from '../answerQueue';
import {
	buildTodayModel,
	missingSummaries,
	parseFromHeader,
	type MailboxDigest,
} from '../todayDigest';
import { parsePeekKey, peekKey, threadHref } from '../todayPeek';

const row = (over: Partial<Parameters<typeof resolveInboxIdentities>[0][number]>) => ({
	mailboxId: 'mb',
	label: 'x',
	address: 'x@example.com',
	scope: 'shared' as const,
	colorSlot: null,
	unread: 0,
	...over,
});

describe('inbox identity', () => {
	it('orders personal before shared and hands out slots in order, explicit first', () => {
		const identities = resolveInboxIdentities([
			row({ mailboxId: 'sales', label: 'Sales', address: 'sales@example.com' }),
			row({ mailboxId: 'me', label: 'Ada Marlow', address: 'ada@example.com', scope: 'personal' }),
			row({ mailboxId: 'support', label: 'Support', address: 'support@example.com', colorSlot: 0 }),
		]);
		expect(identities.map((i) => [i.mailboxId, i.name, i.slot])).toEqual([
			['me', 'Ada', 1],
			['sales', 'Sales', 2],
			['support', 'Support', 0],
		]);
	});

	it('falls back to a neutral chip past the fourth inbox', () => {
		const identities = resolveInboxIdentities(
			['a', 'b', 'c', 'd', 'e'].map((id) => row({ mailboxId: id, label: id.toUpperCase() }))
		);
		expect(identities.map((i) => i.slot)).toEqual([0, 1, 2, 3, null]);
	});

	it('names an unnamed inbox after its address', () => {
		expect(nameFromAddress('customer.success@example.com')).toBe('Customer Success');
		const [identity] = resolveInboxIdentities([
			row({ label: 'help@example.com', address: 'help@example.com' }),
		]);
		expect(identity?.name).toBe('Help');
	});
});

describe('conversation status', () => {
	it('keeps the most urgent status', () => {
		expect(mostUrgentConversationStatus(['waiting', 'updated', 'draft_ready'])).toBe('draft_ready');
		expect(mostUrgentConversationStatus([null])).toBeNull();
	});

	it('derives mail and team statuses from the thread alone', () => {
		expect(mailThreadStatus({ needsReply: { draftSlot: {} } })).toBe('draft_ready');
		expect(mailThreadStatus({ followUp: { dueAt: 1 } })).toBe('needs_you');
		expect(mailThreadStatus({ followUp: {} })).toBe('waiting');
		expect(teamThreadStatus({ latestDraftStatus: 'pending', unread: true })).toBe('draft_ready');
		expect(teamThreadStatus({ unread: true })).toBe('updated');
		expect(teamThreadStatus({ status: 'waiting' })).toBe('waiting');
	});
});

describe('answer queue order', () => {
	const mail = (urgency: 'high' | 'normal' | 'low', at: number) => ({
		source: 'mail' as const,
		at,
		row: { urgency, receivedAt: at },
	});
	it('puts urgent mail first, then team drafts and mentions, then ordinary mail', () => {
		const items = [
			{ id: 'normal', ...mail('normal', 1) },
			{ id: 'mention', source: 'mention' as const, at: 5 },
			{ id: 'high', ...mail('high', 9) },
			{ id: 'team', source: 'team' as const, at: 7 },
		];
		expect([...items].sort(compareAnswerItems).map((i) => i.id)).toEqual([
			'high',
			'team',
			'mention',
			'normal',
		]);
	});
});

const source = (id: string, at: number) => ({
	messageId: id,
	fromName: 'Harbor Design',
	fromAddress: 'studio@harbor.example',
	subject: `Subject ${id}`,
	snippet: 'snippet',
	receivedAt: at,
});

function digest(over: Partial<MailboxDigest> = {}): MailboxDigest {
	return {
		mailboxId: 'mb',
		newMail: 3,
		isNewMailCapped: false,
		changed: [],
		arrived: [],
		filed: { newsletter: 1, notification: 0, receipt: 0, promotion: 0, spam: 0 },
		...over,
	};
}

describe('today model', () => {
	it('splits people from routine mail and adds up filed counts across inboxes', () => {
		const model = buildTodayModel({
			digests: [
				digest({
					arrived: [
						{
							threadId: 't1',
							mailboxId: 'mb',
							subject: 'Files',
							snippet: '',
							summary: 'Harbor sent the files.',
							category: 'person',
							lastMessageAt: 3,
							sources: [source('m1', 3)],
						},
						{
							threadId: 't2',
							mailboxId: 'mb',
							subject: 'Payout',
							snippet: '',
							summary: null,
							category: 'receipt',
							lastMessageAt: 2,
							sources: [source('m2', 2)],
						},
					],
				}),
				digest({ newMail: 2 }),
			],
			teamUpdates: [],
			teamCounts: { promotions: 2, notifications: 1, spam: 0 },
			since: 0,
			pickSummary: () => null,
		});
		expect(model.newMail).toBe(5);
		expect(model.worth.map((l) => [l.text, l.isSummary])).toEqual([
			['Harbor sent the files.', true],
		]);
		expect(model.also.map((l) => [l.lead, l.text])).toEqual([['Harbor Design', 'Payout']]);
		expect(model.filed).toMatchObject({ newsletter: 2, promotion: 2, notification: 1 });
	});

	it('keeps important team updates in "worth knowing" and skips old ones', () => {
		const update = (id: string, at: number, importance: number) => ({
			message: {
				_id: id,
				threadId: `th-${id}`,
				from: 'Northwind Finance <finance@northwind.example>',
				subject: 'Invoice run',
				receivedAt: at,
				classification: { importance, summary: { en: 'Invoice run moves to the 28th.' } },
			},
		});
		const model = buildTodayModel({
			digests: [],
			teamUpdates: [update('new', 10, 0.8), update('old', 1, 0.9), update('minor', 11, 0.1)],
			teamCounts: null,
			since: 5,
			pickSummary: (s) => s?.['en'] ?? null,
		});
		expect(model.worth.map((l) => l.inboundMessageId)).toEqual(['new']);
		expect(model.also.map((l) => l.inboundMessageId)).toEqual(['minor']);
		expect(model.worth[0]?.sources[0]).toMatchObject({
			kind: 'team',
			fromName: 'Northwind Finance',
		});
	});

	it('never drops overflow silently', () => {
		const arrived = Array.from({ length: 20 }, (_, i) => ({
			threadId: `t${i}`,
			mailboxId: 'mb',
			subject: `S${i}`,
			snippet: '',
			summary: null,
			category: 'other',
			lastMessageAt: i,
			sources: [source(`m${i}`, i)],
		}));
		const model = buildTodayModel({
			digests: [digest({ arrived })],
			teamUpdates: [],
			teamCounts: null,
			since: 0,
			pickSummary: () => null,
		});
		expect(model.also.length + model.alsoHidden).toBe(20);
		expect(model.alsoHidden).toBeGreaterThan(0);
	});

	it('asks the summarizer only for lines still showing a subject, newest first', () => {
		expect(
			missingSummaries([
				digest({
					arrived: [
						{
							threadId: 'a',
							mailboxId: 'mb',
							subject: 'A',
							snippet: '',
							summary: 'done',
							category: null,
							lastMessageAt: 5,
							summaryRequest: { messageId: 'ma', sinceCount: 0 },
							sources: [],
						},
						{
							threadId: 'b',
							mailboxId: 'mb',
							subject: 'B',
							snippet: '',
							summary: null,
							category: null,
							lastMessageAt: 1,
							summaryRequest: { messageId: 'mb1', sinceCount: 0 },
							sources: [],
						},
					],
					changed: [
						{
							threadId: 'c',
							mailboxId: 'mb',
							subject: 'C',
							newMessages: 2,
							lastMessageAt: 9,
							snippet: '',
							summary: null,
							summaryRequest: { messageId: 'mc', sinceCount: 3 },
							sources: [],
						},
					],
				}),
			])
		).toEqual([
			{ messageId: 'mc', sinceCount: 3 },
			{ messageId: 'mb1', sinceCount: 0 },
		]);
	});

	it('reads a display name out of a From header', () => {
		expect(parseFromHeader('"Ines Weber" <ines@example.com>')).toEqual({
			name: 'Ines Weber',
			address: 'ines@example.com',
		});
		expect(parseFromHeader('ops@example.com')).toEqual({ name: null, address: 'ops@example.com' });
	});
});

describe('today peek links', () => {
	it('round-trips through the URL and knows where the conversation lives', () => {
		const mail = {
			kind: 'mail' as const,
			id: 'm1',
			threadId: 't1',
			mailboxId: 'mb1',
			fromName: null,
			fromAddress: 'a@b.c',
			subject: '',
			snippet: '',
			at: 0,
		};
		expect(parsePeekKey(peekKey(mail))).toEqual({ kind: 'mail', id: 'm1' });
		expect(parsePeekKey('bogus')).toBeNull();
		expect(threadHref(mail)).toBe('/dashboard/postbox/inbox/m1?mailbox=mb1');
		expect(threadHref({ ...mail, kind: 'team', threadId: 'th1' })).toBe('/dashboard/inbox/th1');
	});
});
