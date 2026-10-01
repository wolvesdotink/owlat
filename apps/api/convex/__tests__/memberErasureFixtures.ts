/**
 * Shared harness + seeds for the member-erasure suites
 * (memberErasure*.integration.test.ts): a convex-test runner with the
 * BetterAuth component registered, a REAL login identity seeded through the
 * component adapter (user, password account, session, passkey, TOTP secret),
 * and helpers to drive, kill and inspect the erasure chain.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { vi } from 'vitest';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';
import { components, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { betterAuthModules, modules } from './gdprAccountFixtures';

export type Harness = TestConvex<typeof schema>;

export const DAY = 24 * 60 * 60 * 1000;
export const IDENTITY_MODELS = ['session', 'account', 'passkey', 'twoFactor', 'member'] as const;

/**
 * `transactionLimits`: `true` enforces Convex's per-transaction limits, an
 * object enforces tighter ones (a scaled-down stand-in for a mailbox the size
 * of the real limit, which convex-test is too slow to seed and walk).
 */
export function erasureHarness(
	transactionLimits: boolean | { documentsRead?: number; bytesRead?: number } = false
): Harness {
	const t = convexTest({ schema, modules, transactionLimits });
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	rateLimiterTest.register(t);
	return t;
}

async function create(t: Harness, model: string, data: Record<string, unknown>) {
	return (await t.mutation(components.betterAuth.adapter.create, {
		input: { model, data },
	} as never)) as { _id: string };
}

/** A login identity with a password, `sessions` live sessions, a passkey and TOTP. */
export async function seedIdentity(
	t: Harness,
	email: string,
	options: { sessions?: number; createdAt?: number } = {}
): Promise<string> {
	const now = Date.now();
	const createdAt = options.createdAt ?? now - 90 * DAY;
	const user = await create(t, 'user', {
		name: 'Erased Person',
		email,
		emailVerified: true,
		createdAt,
		updatedAt: createdAt,
	});
	const userId = user._id;
	await create(t, 'account', {
		accountId: userId,
		providerId: 'credential',
		userId,
		password: 'salt:hash',
		createdAt,
		updatedAt: createdAt,
	});
	for (let i = 0; i < (options.sessions ?? 1); i++) {
		await create(t, 'session', {
			token: `${email}-session-${i}`,
			userId,
			expiresAt: now + 3 * DAY,
			userAgent: 'Mozilla/5.0',
			createdAt: now,
			updatedAt: now,
		});
	}
	await create(t, 'passkey', {
		publicKey: 'pk',
		userId,
		credentialID: `${email}-cred`,
		counter: 0,
		deviceType: 'singleDevice',
		backedUp: false,
	});
	await create(t, 'twoFactor', { secret: 'totp-secret', backupCodes: 'codes', userId });
	return userId;
}

export async function seedOrganization(t: Harness): Promise<string> {
	return (await create(t, 'organization', { name: 'Acme', slug: 'acme', createdAt: Date.now() }))
		._id;
}

export async function seedMembership(
	t: Harness,
	organizationId: string,
	userId: string,
	role: 'owner' | 'admin' | 'editor'
): Promise<void> {
	await create(t, 'member', { organizationId, userId, role, createdAt: Date.now() });
}

/** Profile + a deletion request already past its grace period. */
export async function seedDueRequest(
	t: Harness,
	authUserId: string,
	email: string
): Promise<{ profileId: Id<'userProfiles'>; requestId: Id<'accountDeletionRequests'> }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const profileId = await ctx.db.insert('userProfiles', {
			authUserId,
			email,
			name: 'Erased Person',
			createdAt: now - 90 * DAY,
			updatedAt: now,
		});
		const requestId = await ctx.db.insert('accountDeletionRequests', {
			userProfileId: profileId,
			email,
			requestedAt: now - 31 * DAY,
			scheduledForDeletion: now - 1000,
			cancellationToken: `cancel-${authUserId}`,
			status: 'pending',
			createdAt: now - 31 * DAY,
		});
		return { profileId, requestId };
	});
}

/** An editor with an identity, a profile, a membership and a due request. */
export async function seedEditor(t: Harness, email = 'editor@example.com') {
	const organizationId = await seedOrganization(t);
	const authUserId = await seedIdentity(t, email);
	await seedMembership(t, organizationId, authUserId, 'editor');
	const { profileId, requestId } = await seedDueRequest(t, authUserId, email);
	return { organizationId, authUserId, profileId, requestId };
}

/** A personal mailbox with one folder, thread and message backed by a real blob. */
export async function seedPersonalMailbox(
	t: Harness,
	authUserId: string,
	options: { scope?: 'personal' | 'shared' | 'seed'; address?: string } = {}
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const address = options.address ?? `${authUserId.slice(0, 8)}@example.com`;
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: authUserId,
			organizationId: 'org-x',
			address,
			domain: 'example.com',
			status: 'active' as const,
			...(options.scope ? { scope: options.scope } : {}),
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox' as const,
			uidValidity: now,
			uidNext: 2,
			highestModseq: 1,
			totalCount: 1,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', threadRow(mailboxId, now));
		const rawStorageId = await ctx.storage.store(new Blob(['raw eml bytes']));
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${mailboxId}@example.com>`,
			threadId,
			fromAddress: 'sender@example.com',
			toAddresses: [address],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Private',
			normalizedSubject: 'private',
			snippet: 'private words',
			rawStorageId,
			rawSize: 13,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
		return { mailboxId, folderId, threadId, messageId, rawStorageId };
	});
}

export function threadRow(mailboxId: Id<'mailboxes'>, now: number) {
	return {
		mailboxId,
		normalizedSubject: 'private',
		participants: ['sender@example.com'],
		messageCount: 1,
		unreadCount: 0,
		hasFlagged: false,
		hasAttachments: false,
		lastMessageAt: now,
		firstMessageAt: now,
		latestSnippet: 'private words',
		latestFromAddress: 'sender@example.com',
		latestSubject: 'Private',
		folderRoles: ['inbox'],
		labelIds: [],
		createdAt: now,
		updatedAt: now,
	};
}

export function draftRow(
	mailboxId: Id<'mailboxes'>,
	now: number,
	attachments: Array<{ storageId: Id<'_storage'> }> = []
) {
	return {
		mailboxId,
		toAddresses: ['someone@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		fromAddress: 'me@example.com',
		subject: 'draft subject',
		bodyHtml: '<p>private draft</p>',
		attachments: attachments.map((a, i) => ({
			storageId: a.storageId,
			filename: `file-${i}.txt`,
			contentType: 'text/plain',
			size: 4,
			isInline: false,
		})),
		state: 'draft' as const,
		lastEditedAt: now,
		createdAt: now,
	};
}

export async function runDeletionCron(t: Harness) {
	return await t.mutation(internal.auth.accountDeletion.processPendingDeletions, {});
}

/** Run every scheduled function, chain links included, to quiescence. */
export async function drainScheduled(t: Harness, maxIterations = 500): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers, maxIterations);
}

/** Cancel every pending scheduled function — the erasure chain "dies". */
export async function killScheduledWork(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
		for (const fn of scheduled) {
			if (fn.state.kind === 'pending') await ctx.scheduler.cancel(fn._id);
		}
	});
}

export async function requestOf(t: Harness, requestId: Id<'accountDeletionRequests'>) {
	return await t.run((ctx) => ctx.db.get(requestId));
}

export async function jobOf(t: Harness, requestId: Id<'accountDeletionRequests'>) {
	return await t.run((ctx) =>
		ctx.db
			.query('memberErasureJobs')
			.withIndex('by_request', (q) => q.eq('requestId', requestId))
			.first()
	);
}

/** Rows of `model` in the BetterAuth component still carrying `userId`. */
export async function identityRows(t: Harness, model: string, userId: string): Promise<unknown[]> {
	const result = (await t.query(components.betterAuth.adapter.findMany, {
		model,
		where: [{ field: 'userId', value: userId }],
		paginationOpts: { cursor: null, numItems: 1000 },
	} as never)) as { page: unknown[] };
	return result.page;
}

export async function identityUser(t: Harness, userId: string): Promise<unknown> {
	return await t.query(components.betterAuth.adapter.findOne, {
		model: 'user',
		where: [{ field: '_id', value: userId }],
	} as never);
}
