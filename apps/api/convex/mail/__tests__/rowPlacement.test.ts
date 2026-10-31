/**
 * Read on arrival: every Postbox list row carries its thread's
 * Priority placement, so the Priority view groups any page alike.
 *
 * The placement is the arrival projection's, which is computed with the
 * thread's `placementOverride` (§2.8 precedence step 1): a Fix re-projects the
 * thread, so its placement lands in the projection, except an older digest or
 * updates Fix that an exact-wording candidate overrules. A thread with
 * an override but no projection uses the override; one with neither travels
 * without the key, and the view falls back to its category grouping. Nothing
 * new is read: the thread doc is the one the page already loads for its chips.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
	};
});

beforeEach(() => {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId: 'test-user',
		role: 'owner',
		activeOrganizationId: 'test-org',
	});
});

type T = ReturnType<typeof convexTest>;
type ThreadPatch = Partial<Pick<Doc<'mailThreads'>, 'arrival' | 'placementOverride'>>;

async function seedInbox(t: T): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	await seedFolder(t, mailboxId, 'inbox');
	return mailboxId;
}

/** One inbox message whose thread gets `patch` (an arrival projection, an override). */
async function seedRow(
	t: T,
	mailboxId: Id<'mailboxes'>,
	subject: string,
	patch: (messageId: Id<'mailMessages'>, operationId: Id<'mailArrivalOperations'>) => ThreadPatch
): Promise<Id<'mailMessages'>> {
	const messageId = await seedMessage(t, mailboxId, { subject });
	await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		const now = Date.now();
		const operationId = await ctx.db.insert('mailArrivalOperations', {
			mailboxId,
			kind: 'fix',
			actor: 'user',
			changeCount: 1,
			status: 'applied',
			createdAt: now,
			expiresAt: now + 30 * 86_400_000,
		});
		await ctx.db.patch(message!.threadId, patch(messageId, operationId));
	});
	return messageId;
}

async function placementsBySubject(t: T, mailboxId: Id<'mailboxes'>) {
	const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
		mailboxId,
		folderRole: 'inbox',
	});
	return Object.fromEntries(
		messages.map((row) => [row.subject, 'placement' in row ? row.placement : 'absent'])
	);
}

describe('list rows carry the Priority placement', () => {
	it('reads the arrival projection (which carries a Fix), falls back to an override, and omits it otherwise', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedRow(t, mailboxId, 'shipping', (messageId) => ({
			arrival: { placement: 'updates', depth: 'gist', messageId, decidedAt: 1 },
		}));
		// An ordinary Fix: the override and the projection it re-computed agree.
		await seedRow(t, mailboxId, 'quote', (messageId, operationId) => ({
			arrival: { placement: 'needs_me', depth: 'full', messageId, decidedAt: 2 },
			placementOverride: { placement: 'needs_me', setAt: 2, operationId },
		}));
		// Payment mail after an older digest Fix: the projection lifted it.
		await seedRow(t, mailboxId, 'bank details', (messageId, operationId) => ({
			arrival: { placement: 'today', depth: 'full', messageId, decidedAt: 3 },
			placementOverride: { placement: 'digest', setAt: 1, operationId },
		}));
		await seedRow(t, mailboxId, 'override only', (_messageId, operationId) => ({
			placementOverride: { placement: 'digest', setAt: 2, operationId },
		}));
		await seedRow(t, mailboxId, 'legacy', () => ({}));

		expect(await placementsBySubject(t, mailboxId)).toEqual({
			shipping: 'updates',
			quote: 'needs_me',
			'bank details': 'today',
			'override only': 'digest',
			// Absent, never a present `undefined`: the view's fallback keys off it.
			legacy: 'absent',
		});
	});
});
