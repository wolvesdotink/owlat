/**
 * The brief read and the viewer's writes (mail/interpret/brief.ts,
 * preferences.ts), the state load (load.ts) and the pure projection.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { selectPromptItems } from '../load';
import { resolveThreadDefaultView } from '../preferences';
import { gapOf, sinceLastSeenOf } from '../briefRead';
import { MAX_PROMPT_ITEMS } from '../schema';
import { modules, reduceItem, reduceResult, seedMailThread, seedTeamThread, type Test } from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' } as {
		userId: string;
		role: string;
		activeOrganizationId: string;
	} | null,
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => session.current !== null),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);

async function interpretMail(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	overrides: Record<string, unknown> = {}
) {
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({
			items: [
				reduceItem(),
				reduceItem({
					assertion: 'Confirm the venue',
					display: { en: 'Jonas confirms the venue', de: 'Jonas bestätigt den Ort' },
					responsible: { email: 'jonas@example.com', isUs: false },
					facets: ['meeting'],
					consequences: [],
					due: undefined,
				}),
			],
			facts: [
				{
					key: '["invoice","total",""]',
					assertion: 'The invoice total is 1,200 EUR',
					display: { en: 'Invoice total: 1,200 EUR', de: 'Rechnungssumme: 1.200 EUR' },
					value: { kind: 'money', value: 1200, currency: 'EUR' },
					evidence: [{ segmentId: 's0', start: 0, end: 5, quote: '1,200 EUR' }],
					isVerified: false,
					isReviewNeeded: false,
				},
			],
		}),
		...overrides,
	});
}

describe('brief.get', () => {
	it('shows a personal thread as a brief: latest, standing, for you, waiting on others', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await interpretMail(t, messageId, threadId);
		const view = await t.query(api.mail.interpret.brief.get, {
			threadRef: { kind: 'mail', id: threadId },
			locale: 'de-DE',
		});
		expect(view?.mode).toBe('brief');
		if (view?.mode !== 'brief') throw new Error('unreachable');
		expect(view.completeness).toBe('complete');
		expect(view.gap).toBeUndefined();
		expect(view.latest?.[0]).toMatchObject({
			text: 'Jonas will den Vertrag bis Freitag.',
			evidence: [{ source: { kind: 'mail', id: messageId }, quote: 'send the signed contract' }],
		});
		expect(view.forYou.map((i) => i.text)).toEqual(['Schick den unterschriebenen Vertrag']);
		expect(view.forYou[0]).toMatchObject({ stateKey: 'open', primaryReaction: 'attach', isNew: false });
		expect(view.waitingOnOthers.map((i) => i.text)).toEqual(['Jonas bestätigt den Ort']);
		expect(view.standing?.facts[0]).toMatchObject({ text: 'Rechnungssumme: 1.200 EUR', value: { kind: 'money' } });
		expect(view.counts).toMatchObject({ forYou: 1, waitingOnOthers: 1, forTeam: 0 });
		expect(view.activity.map((a) => a.type)).toEqual(['item_opened', 'item_opened', 'message_received']);
		expect(view.participants.map((p) => p.email)).toContain('jonas@example.com');
	});

	it('says completeness none before any interpretation, never an empty "nothing to do"', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t);
		const view = await t.query(api.mail.interpret.brief.get, {
			threadRef: { kind: 'mail', id: threadId },
			locale: 'en',
		});
		expect(view).toMatchObject({ mode: 'brief', completeness: 'none', gap: { interpretedMessages: 0, totalMessages: 1 } });
	});

	it('shows a failed run as an incomplete brief with its reason', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await interpretMail(t, messageId, threadId, { status: 'failed', errorCode: 'ai_off', result: undefined });
		const view = await t.query(api.mail.interpret.brief.get, {
			threadRef: { kind: 'mail', id: threadId },
			locale: 'en',
		});
		expect(view).toMatchObject({ completeness: 'partial', gap: { reason: 'aiOff' } });
	});

	it('returns null for a caller without access', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t, { userId: 'someone-else' });
		session.current = { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' };
		expect(
			await t.query(api.mail.interpret.brief.get, { threadRef: { kind: 'mail', id: threadId }, locale: 'en' })
		).toBeNull();
		session.current = null;
		expect(
			await t.query(api.mail.interpret.brief.get, { threadRef: { kind: 'mail', id: threadId }, locale: 'en' })
		).toBeNull();
	});

	it('shows a shared mailbox thread in actions mode (no latest, no facts)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t, { scope: 'shared' });
		await interpretMail(t, messageId, threadId, { mode: 'actions', result: reduceResult({ latest: undefined, facts: undefined }) });
		const view = await t.query(api.mail.interpret.brief.get, {
			threadRef: { kind: 'mail', id: threadId },
			locale: 'en',
		});
		expect(view?.mode).toBe('actions');
		if (view?.mode !== 'actions') throw new Error('unreachable');
		expect(view.forTeam.map((i) => i.text)).toEqual(['Send the signed contract']);
		expect(view.counts.forTeam).toBe(1);
		expect(view).not.toHaveProperty('latest');
	});

	it('serves a Team Inbox thread to shared-inbox readers only', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedTeamThread(t);
		const ref = { kind: 'team' as const, id: threadId };
		expect(await t.query(api.mail.interpret.brief.get, { threadRef: ref, locale: 'en' })).toMatchObject({
			mode: 'actions',
			completeness: 'none',
		});
		session.current = { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' };
		expect(await t.query(api.mail.interpret.brief.get, { threadRef: ref, locale: 'en' })).toBeNull();
	});
});

describe('viewer state', () => {
	it('marks the brief seen and reports what changed since', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await interpretMail(t, messageId, threadId);
		await t.mutation(api.mail.interpret.brief.markSeen, { threadRef: ref });
		let view = await t.query(api.mail.interpret.brief.get, { threadRef: ref, locale: 'en' });
		expect(view).toMatchObject({ sinceLastSeen: { newItemIds: [], newActivityCount: 0 } });

		await interpretMail(t, messageId, threadId, {
			contentRevision: 'rev-2',
			expectedRevision: 1,
			sourceAt: SENT + 1,
			result: reduceResult({
				items: [reduceItem({ assertion: 'Book the room', display: { en: 'Book the room', de: 'Buch den Raum' }, facets: ['meeting'] })],
				facts: [],
			}),
		});
		view = await t.query(api.mail.interpret.brief.get, { threadRef: ref, locale: 'en' });
		if (view?.mode !== 'brief') throw new Error('unreachable');
		expect(view.sinceLastSeen?.newItemIds).toHaveLength(1);
		expect(view.forYou.find((i) => i.text === 'Book the room')?.isNew).toBe(true);
	});

	it('stores and clears a per-thread view override, personal mail threads only', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await t.mutation(api.mail.interpret.brief.setViewOverride, { threadRef: ref, view: 'conversation' });
		const read = () =>
			t.run(async (ctx) =>
				ctx.db
					.query('threadViewerState')
					.withIndex('by_user_and_mail_thread', (q) => q.eq('userId', 'user-A').eq('mailThreadId', threadId))
					.first()
			);
		expect((await read())?.viewOverride).toBe('conversation');
		await t.mutation(api.mail.interpret.brief.setViewOverride, { threadRef: ref, view: null });
		expect((await read())?.viewOverride).toBeUndefined();

		const team = await seedTeamThread(t);
		await expect(
			t.mutation(api.mail.interpret.brief.setViewOverride, {
				threadRef: { kind: 'team', id: team.threadId },
				view: 'overview',
			})
		).rejects.toThrow();
	});

	it('refuses markSeen on a thread the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedMailThread(t, { userId: 'someone-else' });
		session.current = { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' };
		await expect(
			t.mutation(api.mail.interpret.brief.markSeen, { threadRef: { kind: 'mail', id: threadId } })
		).rejects.toThrow();
	});
});

describe('view preference (D1)', () => {
	it('defaults to Overview, Conversation when auto-summarize is off, and the explicit choice wins', () => {
		expect(resolveThreadDefaultView(null)).toBe('overview');
		expect(resolveThreadDefaultView({ isAutoSummarizeOn: false })).toBe('conversation');
		expect(resolveThreadDefaultView({ isAutoSummarizeOn: false, threadDefaultView: 'overview' })).toBe('overview');
	});

	it('saves the default on a team-only install', async () => {
		const t = convexTest(schema, modules);
		await seedTeamThread(t); // turns `inbox` on, no Postbox flag
		expect(await t.query(api.mail.interpret.preferences.getViewPreference, {})).toEqual({
			threadDefaultView: 'overview',
			isExplicit: false,
		});
		await t.mutation(api.mail.interpret.preferences.setThreadDefaultView, { view: 'conversation' });
		expect(await t.query(api.mail.interpret.preferences.getViewPreference, {})).toEqual({
			threadDefaultView: 'conversation',
			isExplicit: true,
		});
	});
});

describe('state load', () => {
	it('puts open items first, recent closed ones next, and says when the page overflowed', () => {
		const now = 10 * 24 * 60 * 60 * 1000 + 1e12;
		const open = Array.from({ length: MAX_PROMPT_ITEMS + 2 }, (_, i) => ({
			id: `o${i}`,
			status: 'open',
			askedAt: 100 - i,
			updatedAt: now,
		}));
		const closed = [
			{ id: 'c-old', status: 'done', askedAt: 0, updatedAt: now - 40 * 24 * 60 * 60 * 1000 },
			{ id: 'c-new', status: 'done', askedAt: 0, updatedAt: now - 1000 },
		];
		const page = selectPromptItems([...closed, ...open], now);
		expect(page.isOverflow).toBe(true);
		expect(page.page).toHaveLength(MAX_PROMPT_ITEMS);
		expect(page.page[0]?.id).toBe(`o${MAX_PROMPT_ITEMS + 1}`);

		const small = selectPromptItems([...closed, ...open.slice(0, 2)], now);
		expect(small).toEqual({ page: [open[1], open[0], closed[1]], isOverflow: false });
	});

	it('loads the source, its participants, the brief revision and the open items', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, mailboxId } = await seedMailThread(t);
		await interpretMail(t, messageId, threadId);
		const loaded = await t.query(internal.mail.interpret.load.loadForInterpretation, {
			source: { kind: 'mail', id: messageId },
		});
		expect(loaded).toMatchObject({
			threadRef: { kind: 'mail', id: threadId },
			mode: 'brief',
			direction: 'inbound',
			mailboxId,
			brief: { interpretationRevision: 1, deletionEpoch: 0 },
			isItemsOverflow: false,
			eligibility: { isLive: true, folder: 'inbox', isThreadMuted: false },
			locales: ['en', 'de'],
		});
		expect(loaded?.participants).toEqual([
			{ ref: 'p1', role: 'from', email: 'jonas@example.com', isUs: false },
			{ ref: 'p2', role: 'to', email: 'me@example.com', isUs: false },
		]);
		expect(loaded?.openItems).toHaveLength(2);
		expect(loaded?.openItems[0]?.evidenceExcerpt).toBe('send the signed contract');
		expect(loaded?.currentFacts).toHaveLength(1);
		expect(loaded?.previous[0]).toMatchObject({ contentRevision: 'rev-1', isApplied: true });
	});
});

describe('pure read helpers', () => {
	it('counts what changed past the seen seq', () => {
		const item = 'i1' as Id<'threadItems'>;
		const other = 'i2' as Id<'threadItems'>;
		expect(
			sinceLastSeenOf(
				[
					{ seq: 5, type: 'item_closed', itemId: other, visibility: 'substance' },
					{ seq: 4, type: 'item_opened', itemId: item, visibility: 'substance' },
					{ seq: 3, type: 'assigned', visibility: 'housekeeping' },
					{ seq: 2, type: 'item_opened', itemId: other, visibility: 'substance' },
				],
				2
			)
		).toEqual({ newItemIds: [item], changedItemIds: [other], newActivityCount: 2 });
	});

	it('explains the gap from the newest problem, then pending, then the suppressed latest', () => {
		const row = (sourceKey: string, status: 'complete' | 'partial' | 'failed', updatedAt: number, errorCode?: string) => ({
			sourceKey,
			status,
			updatedAt,
			...(errorCode ? { errorCode } : {}),
		});
		expect(gapOf([row('a', 'complete', 1), row('b', 'partial', 2, 'overflow')], { totalMessages: 3, isPending: false })).toEqual({
			interpretedMessages: 2,
			totalMessages: 3,
			reason: 'tooLong',
		});
		expect(gapOf([], { totalMessages: 1, isPending: true })).toMatchObject({ reason: 'pending' });
		expect(gapOf([row('a', 'complete', 1)], { totalMessages: 1, isPending: false, suppressed: 'short' })).toMatchObject({
			reason: 'short',
		});
	});
});
