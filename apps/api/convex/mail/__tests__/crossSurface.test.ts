/**
 * Link the same conversation across Postbox and Team Inbox (idea 31).
 *
 * The correlation itself is the easy half. The load-bearing half is the
 * authorization: the viewer must be permitted on BOTH sides, in either
 * direction, and a failure returns null rather than "a match exists" — because
 * the mere existence of a counterpart is already information about the other
 * surface.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { messageIdCandidates } from '../crossSurface';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

const flagMocks = vi.hoisted(() => ({ inbox: true }));
vi.mock('../../lib/featureFlags', async () => {
	const actual = await vi.importActual('../../lib/featureFlags');
	return {
		...actual,
		isFeatureEnabled: vi.fn(async (_ctx: unknown, flag: string) =>
			flag === 'inbox' ? flagMocks.inbox : true
		),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
	flagMocks.inbox = true;
});

const RFC_ID = 'CAF=abc123@mail.example';

describe('messageIdCandidates', () => {
	it('tries both stored spellings, because the two ingests disagree', () => {
		// Postbox strips the angle brackets at ingest; the AI-inbox path keeps the
		// header as it arrived. Correlating on one spelling would miss the other.
		expect(messageIdCandidates('<x@y>')).toContain('x@y');
		expect(messageIdCandidates('x@y')).toContain('<x@y>');
	});

	it('yields nothing for an empty or bracket-only id', () => {
		expect(messageIdCandidates('   ')).toEqual([]);
		expect(messageIdCandidates('<>')).toEqual([]);
	});
});

async function seedBothSides(t: TestConvex<typeof schema>): Promise<{
	mailboxId: Id<'mailboxes'>;
	messageId: Id<'mailMessages'>;
	inboundMessageId: Id<'inboundMessages'>;
}> {
	const mailboxId = await seedMailbox(t);
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, {
		subject: 'Refund never arrived',
		rfc822MessageId: RFC_ID,
	});
	const inboundMessageId = await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: 'user-ana',
			name: 'Ana',
			email: 'ana@hinterland.camp',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Refund never arrived',
			normalizedSubject: 'refund never arrived',
			contactIdentifier: 'sofia@example.com',
			status: 'open',
			assignedTo: 'user-ana',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		});
		return ctx.db.insert('inboundMessages', {
			// Stored WITH brackets — the spelling the AI-inbox path keeps.
			messageId: `<${RFC_ID}>`,
			from: 'sofia@example.com',
			to: 'team@hinterland.camp',
			subject: 'Refund never arrived',
			threadId,
			processingStatus: 'draft_ready',
			receivedAt: Date.now(),
		});
	});
	return { mailboxId, messageId, inboundMessageId };
}

describe('mail.crossSurface.teamInboxFor', () => {
	it('names the assignee and the pending draft across the bracket mismatch', async () => {
		const t = convexTest(schema, modules);
		const { messageId, inboundMessageId } = await seedBothSides(t);
		const strip = await t.query(api.mail.crossSurface.teamInboxFor, { messageId });
		expect(strip).toMatchObject({
			inboundMessageId,
			assigneeName: 'Ana',
			isDraftPending: true,
			isReplied: false,
		});
	});

	it('reveals nothing when the viewer has no Team Inbox access', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedBothSides(t);
		// Postbox side would pass on its own — the mailbox belongs to this user —
		// but the shared inbox is admin-only, so the whole answer is withheld.
		sessionMocks.role = 'editor';
		expect(await t.query(api.mail.crossSurface.teamInboxFor, { messageId })).toBeNull();
	});

	it('reveals nothing when the Team Inbox feature is off', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedBothSides(t);
		flagMocks.inbox = false;
		expect(await t.query(api.mail.crossSurface.teamInboxFor, { messageId })).toBeNull();
	});

	it('returns null when nothing correlates', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const messageId = await seedMessage(t, mailboxId, { subject: 'lonely' });
		expect(await t.query(api.mail.crossSurface.teamInboxFor, { messageId })).toBeNull();
	});
});

describe('mail.crossSurface.postboxFor', () => {
	it('names the personal copy and where it sits', async () => {
		const t = convexTest(schema, modules);
		const { messageId, inboundMessageId } = await seedBothSides(t);
		const strip = await t.query(api.mail.crossSurface.postboxFor, { inboundMessageId });
		expect(strip).toMatchObject({
			messageId,
			mailboxAddress: 'a@hinterland.camp',
			folderRole: 'inbox',
			isAnswered: false,
		});
	});

	it('withholds the mirror from a viewer without Team Inbox access', async () => {
		const t = convexTest(schema, modules);
		const { inboundMessageId } = await seedBothSides(t);
		sessionMocks.role = 'editor';
		expect(await t.query(api.mail.crossSurface.postboxFor, { inboundMessageId })).toBeNull();
	});

	it('skips a personal copy in a mailbox the access predicate rejects', async () => {
		const t = convexTest(schema, modules);
		const { inboundMessageId } = await seedBothSides(t);
		// A suspended mailbox is not readable by anyone, org admins included —
		// the Postbox-side re-check is what stops the mirror naming it anyway.
		await t.run(async (ctx) => {
			const mailbox = await ctx.db.query('mailboxes').first();
			if (mailbox) await ctx.db.patch(mailbox._id, { status: 'suspended' });
		});
		expect(await t.query(api.mail.crossSurface.postboxFor, { inboundMessageId })).toBeNull();
	});
});
