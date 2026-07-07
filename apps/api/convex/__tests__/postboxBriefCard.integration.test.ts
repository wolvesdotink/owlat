/**
 * Daily Brief card cache (mail/brief.ts) — the freshness policy and fail-soft
 * behavior behind the Today-view greeting card:
 *
 *   - a fresh same-day card is served untouched ("at most once per morning":
 *     refresh is idempotent while the cache is fresh)
 *   - >= NEW_MAIL_STALE_THRESHOLD new messages since generation flip the read
 *     to stale and let refresh regenerate early
 *   - a new local day flips the read to stale and regeneration clears a
 *     previous day's dismissal
 *   - dismiss hides the card for the dismissed local day only
 *   - no access (inactive mailbox) returns null — no brief, never an error
 *
 * Deterministic throughout — the card is template counts, so no LLM mock is
 * needed (unlike the thread-summary cache these rules mirror).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { NEW_MAIL_STALE_THRESHOLD } from '../mail/brief';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

// AWS-SDK / heavy node-only modules aren't on the path under test; drop them.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing')
	)
);

const OWNER = 'me@example.com';
const LOCAL_DAY = '2026-07-07';
const NEXT_DAY = '2026-07-08';
// A local-midnight timestamp safely in the past relative to Date.now().
const DAY_START = Date.now() - 6 * 60 * 60 * 1000;

async function seedMailbox(
	t: TestConvex<typeof schema>,
	overrides: { status?: 'active' | 'suspended' } = {}
): Promise<Id<'mailboxes'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: OWNER,
			domain: 'example.com',
			status: overrides.status ?? 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		return mailboxId;
	});
}

/** Seed `count` inbound inbox messages received at `receivedAt` (+i each). */
async function seedMessages(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	count: number,
	receivedAt: number
): Promise<void> {
	await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first();
		const now = Date.now();
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hello',
			participants: ['alice@example.com', OWNER],
			messageCount: count,
			unreadCount: count,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: receivedAt + count,
			firstMessageAt: receivedAt,
			latestSnippet: 'hi',
			latestFromAddress: 'alice@example.com',
			latestSubject: 'Hello',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		for (let i = 0; i < count; i++) {
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: folder!._id,
				uid: Math.floor(receivedAt % 1e9) + i,
				modseq: i + 1,
				rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
				threadId,
				fromAddress: 'alice@example.com',
				toAddresses: [OWNER],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Hello',
				normalizedSubject: 'hello',
				snippet: 'hi',
				textBodyInline: 'hi there',
				rawStorageId,
				rawSize: 3,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: receivedAt + i,
				internalDate: receivedAt + i,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

/** Seed a needs-reply thread with an open clarification + overnight draft slot. */
async function seedAgentActivity(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'invoice',
			participants: ['bob@example.com', OWNER],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'invoice',
			latestFromAddress: 'bob@example.com',
			latestSubject: 'Invoice',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first();
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: folder!._id,
			uid: 999_999,
			modseq: 1,
			rfc822MessageId: `<agent-${Math.random().toString(36).slice(2)}@example.com>`,
			threadId,
			fromAddress: 'bob@example.com',
			toAddresses: [OWNER],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Invoice',
			normalizedSubject: 'invoice',
			snippet: 'invoice',
			textBodyInline: 'please pay',
			rawStorageId,
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: DAY_START - 60_000, // pre-midnight: not a "new today" row
			internalDate: DAY_START - 60_000,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(threadId, {
			needsReply: {
				messageId,
				detectedAt: now,
				source: 'llm',
				urgency: 'normal',
				clarification: {
					isNeeded: true,
					questions: [
						{
							id: 'q1',
							slotType: 'fact',
							text: 'Which PO number applies?',
							attribution: 'Asked because Bob referenced a PO',
						},
					],
					askedAt: now,
				},
				draftSlot: {
					draft: 'Hi Bob, — thanks!',
					confidence: 0.9,
					generatedAt: DAY_START - 60 * 60 * 1000, // overnight window
				},
			},
		});
	});
}

describe('mail.brief freshness policy', () => {
	it('no cache yet: read is stale, refresh generates, second refresh is a no-op (once per morning)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const mailboxId = await seedMailbox(t);
		await seedMessages(t, mailboxId, 2, DAY_START + 1000);
		await seedAgentActivity(t, mailboxId);

		const cold = await t.query(api.mail.brief.getBriefCard, { mailboxId, localDay: LOCAL_DAY });
		expect(cold).toEqual({ card: null, isStale: true, isDismissed: false });

		const first = await t.mutation(api.mail.brief.refresh, {
			mailboxId,
			localDay: LOCAL_DAY,
			dayStartTs: DAY_START,
		});
		expect(first?.localDay).toBe(LOCAL_DAY);

		const warm = await t.query(api.mail.brief.getBriefCard, { mailboxId, localDay: LOCAL_DAY });
		expect(warm?.isStale).toBe(false);
		expect(warm?.isDismissed).toBe(false);
		expect(warm?.card?.counts).toEqual({ newMail: 2, drafted: 1, questions: 1, autoFiled: 0 });

		// Same morning, nothing new: refresh must NOT regenerate.
		const again = await t.mutation(api.mail.brief.refresh, {
			mailboxId,
			localDay: LOCAL_DAY,
			dayStartTs: DAY_START,
		});
		expect(again?.generatedAt).toBe(first?.generatedAt);
	});

	it(`>= ${NEW_MAIL_STALE_THRESHOLD} new messages since generation flip the card stale and refresh regenerates`, async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const mailboxId = await seedMailbox(t);
		const first = await t.mutation(api.mail.brief.refresh, {
			mailboxId,
			localDay: LOCAL_DAY,
			dayStartTs: DAY_START,
		});

		// One trickle-in message is NOT enough.
		await seedMessages(t, mailboxId, 1, Date.now() + 1000);
		const trickle = await t.query(api.mail.brief.getBriefCard, { mailboxId, localDay: LOCAL_DAY });
		expect(trickle?.isStale).toBe(false);

		// The threshold is.
		await seedMessages(t, mailboxId, NEW_MAIL_STALE_THRESHOLD - 1, Date.now() + 2000);
		const busy = await t.query(api.mail.brief.getBriefCard, { mailboxId, localDay: LOCAL_DAY });
		expect(busy?.isStale).toBe(true);

		const second = await t.mutation(api.mail.brief.refresh, {
			mailboxId,
			localDay: LOCAL_DAY,
			dayStartTs: DAY_START,
		});
		// Regeneration is proven by the counts (same-ms timestamps can tie):
		// the first card saw 0 new messages, the regenerated one sees all 5.
		expect(second?.generatedAt).toBeGreaterThanOrEqual(first!.generatedAt);
		const warm = await t.query(api.mail.brief.getBriefCard, { mailboxId, localDay: LOCAL_DAY });
		expect(warm?.card?.counts.newMail).toBe(NEW_MAIL_STALE_THRESHOLD);
	});

	it('a new local day is stale and regeneration clears the previous day dismissal', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.brief.refresh, {
			mailboxId,
			localDay: LOCAL_DAY,
			dayStartTs: DAY_START,
		});
		await t.mutation(api.mail.brief.dismiss, { mailboxId, localDay: LOCAL_DAY });

		const dismissed = await t.query(api.mail.brief.getBriefCard, {
			mailboxId,
			localDay: LOCAL_DAY,
		});
		expect(dismissed?.isDismissed).toBe(true);

		// Next morning: yesterday's card is stale, yesterday's dismissal is gone.
		const nextMorning = await t.query(api.mail.brief.getBriefCard, {
			mailboxId,
			localDay: NEXT_DAY,
		});
		expect(nextMorning?.isStale).toBe(true);
		expect(nextMorning?.isDismissed).toBe(false);

		await t.mutation(api.mail.brief.refresh, {
			mailboxId,
			localDay: NEXT_DAY,
			dayStartTs: DAY_START + 24 * 60 * 60 * 1000,
		});
		const fresh = await t.query(api.mail.brief.getBriefCard, { mailboxId, localDay: NEXT_DAY });
		expect(fresh?.isStale).toBe(false);
		expect(fresh?.isDismissed).toBe(false);
	});

	it('fail-soft: an inactive mailbox yields null from read, refresh and dismiss', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const mailboxId = await seedMailbox(t, { status: 'suspended' });

		expect(
			await t.query(api.mail.brief.getBriefCard, { mailboxId, localDay: LOCAL_DAY })
		).toBeNull();
		expect(
			await t.mutation(api.mail.brief.refresh, {
				mailboxId,
				localDay: LOCAL_DAY,
				dayStartTs: DAY_START,
			})
		).toBeNull();
		expect(await t.mutation(api.mail.brief.dismiss, { mailboxId, localDay: LOCAL_DAY })).toBeNull();
	});
});
