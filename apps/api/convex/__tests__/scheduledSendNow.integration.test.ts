/**
 * Send now on a scheduled draft (`mail.scheduledSends.sendNow`, handler in
 * mail/draftSend.ts): the schedule is withdrawn and the ordinary send starts in
 * one transaction.
 *
 *  - it queues exactly one send, with a fresh undo token, and a second click
 *    (or another tab) finds nothing scheduled;
 *  - the dispatch hop scheduled for the original time finds a stale token and
 *    sends nothing;
 *  - Cancel returns the draft to Drafts with its content, and Send now on it
 *    then does nothing;
 *  - a draft already gone or already sending answers `{ ok: false }`;
 *  - a send the checks refuse leaves the draft scheduled as it was.
 */
import { convexTest as baseConvexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { seedFolder, seedMailbox } from '../mail/__tests__/helpers.testlib';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner',
}));
vi.mock('../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	isActiveOrgMember: vi.fn(async () => true),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

const NOW = Date.UTC(2026, 9, 21, 8, 0);
const DAY = 24 * 60 * 60 * 1000;
const LATER = NOW + 2 * DAY;

function convexTest(): Harness {
	const t = baseConvexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'], now: NOW });
	session.userId = 'user-A';
	session.role = 'owner';
});
afterEach(() => {
	vi.useRealTimers();
});

/** A draft scheduled through the real send path, and the token its dispatch hop carries. */
async function scheduledDraft(
	t: Harness,
	opts: { to?: string[] } = {}
): Promise<{ draftId: Id<'mailDrafts'>; scheduledToken: string }> {
	const mailboxId = await seedMailbox(t, { userId: 'user-A' });
	await seedFolder(t, mailboxId, 'sent');
	const draftId = await t.run((ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: ['ines@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'a@owlat.test',
			subject: 'Re: Offer',
			bodyHtml: '<p>Here it is.</p>',
			attachments: [],
			state: 'draft',
			lastEditedAt: NOW,
			createdAt: NOW,
		})
	);
	const { undoToken } = await t.mutation(api.mail.drafts.send, {
		draftId,
		scheduledSendAt: LATER,
	});
	if (opts.to) await t.run((ctx) => ctx.db.patch(draftId, { toAddresses: opts.to }));
	return { draftId, scheduledToken: undoToken };
}

const row = (t: Harness, draftId: Id<'mailDrafts'>) => t.run((ctx) => ctx.db.get(draftId));

/** The dispatch hops scheduled for this draft, by the token each carries. */
async function dispatchTokens(t: Harness, draftId: Id<'mailDrafts'>): Promise<string[]> {
	const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
	return jobs
		.filter((job) => job.name.includes('dispatchDraft'))
		.map((job) => job.args[0] as { draftId: string; undoToken: string })
		.filter((args) => args.draftId === draftId)
		.map((args) => args.undoToken);
}

describe('scheduledSends.sendNow', () => {
	it('queues one send with a fresh token, and a second click finds nothing scheduled', async () => {
		const t = convexTest();
		const { draftId, scheduledToken } = await scheduledDraft(t);

		const result = await t.mutation(api.mail.scheduledSends.sendNow, {
			draftId,
			undoSendDelayMs: 5_000,
		});
		expect(result).toMatchObject({ ok: true, sendAt: NOW + 5_000 });
		if (!result.ok) throw new Error('expected a send');
		expect(result.undoToken).not.toBe(scheduledToken);

		const sending = await row(t, draftId);
		expect(sending).toMatchObject({
			state: 'pending_send',
			undoToken: result.undoToken,
			scheduledSendAt: NOW + 5_000,
			sentByUserId: 'user-A',
		});
		expect((await dispatchTokens(t, draftId)).sort()).toEqual(
			[scheduledToken, result.undoToken].sort()
		);

		expect(await t.mutation(api.mail.scheduledSends.sendNow, { draftId })).toEqual({ ok: false });
		expect(await row(t, draftId)).toMatchObject({
			state: 'pending_send',
			undoToken: result.undoToken,
		});
		expect(await dispatchTokens(t, draftId)).toHaveLength(2);
	});

	it('leaves the dispatch hop scheduled for the original time with nothing to send', async () => {
		const t = convexTest();
		const { draftId, scheduledToken } = await scheduledDraft(t);
		const result = await t.mutation(api.mail.scheduledSends.sendNow, { draftId });
		if (!result.ok) throw new Error('expected a send');

		await t.action(internal.mail.outbound.dispatchDraft, { draftId, undoToken: scheduledToken });

		expect(await row(t, draftId)).toMatchObject({
			state: 'pending_send',
			undoToken: result.undoToken,
		});
		const sent = await t.run((ctx) => ctx.db.query('mailMessages').collect());
		expect(sent).toEqual([]);
	});

	it('keeps the draft in Drafts on Cancel, where Send now does nothing', async () => {
		const t = convexTest();
		const { draftId } = await scheduledDraft(t);

		expect(await t.mutation(api.mail.drafts.cancelScheduledSend, { draftId })).toEqual({
			ok: true,
			draftId,
		});
		const draft = await row(t, draftId);
		expect(draft).toMatchObject({
			state: 'draft',
			subject: 'Re: Offer',
			toAddresses: ['ines@example.com'],
		});
		expect(draft?.scheduledSendAt).toBeUndefined();
		expect(draft?.undoToken).toBeUndefined();
		expect(await t.mutation(api.mail.scheduledSends.sendNow, { draftId })).toEqual({ ok: false });
		expect((await row(t, draftId))?.state).toBe('draft');
	});

	it('answers { ok: false } for a draft already dispatched', async () => {
		const t = convexTest();
		const { draftId } = await scheduledDraft(t);
		await t.run((ctx) => ctx.db.delete(draftId));
		expect(await t.mutation(api.mail.scheduledSends.sendNow, { draftId })).toEqual({ ok: false });
	});

	it('leaves the draft scheduled when the send is refused', async () => {
		const t = convexTest();
		const { draftId, scheduledToken } = await scheduledDraft(t, { to: [] });

		await expect(t.mutation(api.mail.scheduledSends.sendNow, { draftId })).rejects.toThrow(
			/No recipients/
		);
		expect(await row(t, draftId)).toMatchObject({
			state: 'scheduled',
			undoToken: scheduledToken,
			scheduledSendAt: LATER,
		});
	});

	it("refuses someone else's draft", async () => {
		const t = convexTest();
		const { draftId } = await scheduledDraft(t);
		session.userId = 'user-B';
		session.role = 'editor';
		await expect(t.mutation(api.mail.scheduledSends.sendNow, { draftId })).rejects.toThrow(
			/not accessible/
		);
		expect((await row(t, draftId))?.state).toBe('scheduled');
	});
});
