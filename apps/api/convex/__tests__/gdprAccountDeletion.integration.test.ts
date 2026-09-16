/**
 * The account-deletion path: a non-owner member's deletion erases their
 * auth-side rows + onboarding + profile and hands off to the batched
 * member-erasure walk (auth/memberErasure.ts); that walk anonymizes/erases the
 * member's mailbox, app passwords, external credentials, chat authorship and
 * staged export artifacts, then terminates by marking the request `completed`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TestConvex } from 'convex-test';
import schema from '../schema';
import { internal, components } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { resetSessionMock } from './gdprSessionMock';
import {
	newHarness,
	seedProfile,
	seedOrg,
	seedMember,
	seedDeliverabilityAlertRecipients,
} from './gdprAccountFixtures';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

beforeEach(resetSessionMock);
afterEach(() => {
	vi.unstubAllEnvs();
});

// ============================================================
// account-deletion path — non-owner member
// ============================================================

describe('accountManagement.deleteAccountForRequest — non-owner member', () => {
	it('erases auth-side rows + onboarding + profile and hands off member erasure', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		// Onboarding row keyed by BetterAuth userId.
		await t.run(async (ctx) => {
			await ctx.db.insert('onboardingProgress', {
				userId: 'auth-user-1',
				dismissed: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'me@example.com',
				requestedAt: Date.now(),
				// Past its grace period so the cron picks it up.
				scheduledForDeletion: Date.now() - 1000,
				cancellationToken: 'tok',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		// Drive the real cron entry point (a proper mutation that wraps
		// deleteAccountForRequest in a transaction + schedules erasure).
		const result = await t.mutation(internal.auth.accountDeletion.processPendingDeletions, {});
		expect(result.processedCount).toBe(1);

		await t.run(async (ctx) => {
			// Profile + onboarding gone.
			expect(await ctx.db.get(profileId)).toBeNull();
			const onboarding = await ctx.db
				.query('onboardingProgress')
				.withIndex('by_user', (q) => q.eq('userId', 'auth-user-1'))
				.collect();
			expect(onboarding).toHaveLength(0);
		});

		// BetterAuth membership row was deleted.
		const remainingMembers = (await t.query(components.betterAuth.adapter.findMany, {
			model: 'member',
			where: [{ field: 'userId', value: 'auth-user-1' }],
			paginationOpts: { cursor: null, numItems: 100 },
		} as never)) as { page: unknown[] };
		expect(remainingMembers.page).toHaveLength(0);

		// Request is NOT yet completed: the batched member-erasure walk owns that
		// transition (it was scheduled, not run inline). Still pending here.
		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('pending');
		});

		// Run the member-erasure walk the cron handed off to. This member owns no
		// personal data, so it terminates in one hop, marking the request done.
		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId: 'auth-user-1',
			requestId,
		});
		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId: 'auth-user-1',
			requestId,
			isAlertErasureDone: true,
			isAlertReceiptErasureDone: true,
		});
		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});
});

// ============================================================
// member-erasure batched walk (auth/memberErasure.ts)
// ============================================================

describe('memberErasure.eraseMemberData', () => {
	/** Drive the self-rescheduling walk to completion deterministically. */
	async function drainWalk(
		t: TestConvex<typeof schema>,
		authUserId: string,
		requestId: Id<'accountDeletionRequests'>
	): Promise<void> {
		// Bounded loop — every hop either deletes a batch (and reschedules) or
		// reaches phase 4. A handful of hops covers the seeded data.
		for (let i = 0; i < 20; i++) {
			const erasureState = await t.run(async (ctx) => {
				const recipient = await ctx.db
					.query('deliverabilityAlertRecipients')
					.withIndex('by_user', (q) => q.eq('userId', authUserId))
					.first();
				const receipt = await ctx.db
					.query('deliverabilityAlertRecipientReceipts')
					.withIndex('by_user', (q) => q.eq('userId', authUserId))
					.first();
				return {
					isAlertErasureDone: recipient === null,
					isAlertReceiptErasureDone: receipt === null,
				};
			});
			await t.mutation(internal.auth.memberErasure.eraseMemberData, {
				authUserId,
				requestId,
				...(erasureState.isAlertErasureDone ? { isAlertErasureDone: true } : {}),
				...(erasureState.isAlertReceiptErasureDone ? { isAlertReceiptErasureDone: true } : {}),
			});
			const done = await t.run(async (ctx) => {
				const r = await ctx.db.get(requestId);
				return r?.status === 'completed';
			});
			if (done) return;
		}
		throw new Error('member-erasure walk did not terminate within hop budget');
	}

	it('erases the mailbox + app passwords, external creds, chat authorship and completes the request', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-2';
		const profileId = await seedProfile(t, authUserId, 'member@example.com');

		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'member@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'tok2',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		// Seed the personal mailbox (+ one message with real storage blobs), an
		// app password keyed to the mailbox, an external IMAP account with a
		// folder-sync row, a user-keyed app password, and chat authorship — both
		// the member's own messages and another author's.
		const { mailboxId, otherAuthorMessageId } = await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: authUserId,
				organizationId: 'org-x',
				address: 'member@example.com',
				domain: 'example.com',
				status: 'active' as const,
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
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['member@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'a@example.com',
				latestSubject: 'hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw eml bytes']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<m1@example.com>',
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['member@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'hi',
				normalizedSubject: 'hi',
				snippet: 'hi',
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

			// App password keyed to the mailbox.
			await ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: authUserId,
				label: 'iPhone',
				passwordHash: 'salt:hash',
				passwordPrefix: 'abcd',
				scopes: ['imap' as const],
				createdAt: now,
			});

			// External IMAP account + folder-sync row.
			const accountId = await ctx.db.insert('externalMailAccounts', {
				userId: authUserId,
				organizationId: 'org-x',
				mailboxId,
				imapHost: 'imap.example.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example.com',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: 'member@example.com',
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('externalMailFolderSync', {
				accountId,
				mailboxId,
				folderId,
				remoteName: 'INBOX',
				remoteUidValidity: 1,
				lastSeenUid: 0,
				lastSyncedAt: now,
			});

			// Chat: a room with the member's own message + another author's.
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel' as const,
				name: 'general',
				normalizedName: 'general',
				visibility: 'public' as const,
				createdBy: authUserId,
				lastMessageAt: now,
				messageCount: 2,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: authUserId,
				text: 'mine',
				createdAt: now,
			});
			const otherAuthorMessageId = await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'someone-else',
				text: 'theirs',
				createdAt: now,
			});
			await ctx.db.insert('chatRoomMembers', {
				roomId,
				memberId: authUserId,
				role: 'member' as const,
				joinedAt: now,
				lastReadAt: now,
			});

			return { mailboxId, otherAuthorMessageId };
		});

		await drainWalk(t, authUserId, requestId);

		await t.run(async (ctx) => {
			// Mailbox + its message gone.
			expect(await ctx.db.get(mailboxId)).toBeNull();
			const messages = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.collect();
			expect(messages).toHaveLength(0);

			// App passwords (mailbox- and user-keyed) gone.
			const appPasswords = await ctx.db
				.query('mailAppPasswords')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(appPasswords).toHaveLength(0);

			// External credentials + sync rows gone.
			const externalAccounts = await ctx.db
				.query('externalMailAccounts')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(externalAccounts).toHaveLength(0);

			// Chat: the member's authorship is anonymized; others are untouched.
			const authored = await ctx.db
				.query('chatMessages')
				.withIndex('by_author', (q) => q.eq('authorId', authUserId))
				.collect();
			expect(authored).toHaveLength(0);
			const anonymized = await ctx.db
				.query('chatMessages')
				.withIndex('by_author', (q) => q.eq('authorId', '[deleted account]'))
				.collect();
			expect(anonymized).toHaveLength(1);
			expect(anonymized[0]!.text).toBe('mine');

			// Another author's message is unchanged.
			const other = await ctx.db.get(otherAuthorMessageId);
			expect(other?.authorId).toBe('someone-else');

			// Room membership dropped.
			const memberships = await ctx.db
				.query('chatRoomMembers')
				.withIndex('by_member', (q) => q.eq('memberId', authUserId))
				.collect();
			expect(memberships).toHaveLength(0);

			// Request marked completed — the walk terminated.
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});

	it('anonymizes more than one recipient-ledger page and reconciles each parent alert', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-with-alerts';
		const profileId = await seedProfile(t, authUserId);
		const requestId = await t.run((ctx) =>
			ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'alerts@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'alert-ledger-token',
				status: 'pending',
				createdAt: Date.now(),
			})
		);
		await seedDeliverabilityAlertRecipients(t, authUserId, 101);

		await drainWalk(t, authUserId, requestId);

		await t.run(async (ctx) => {
			const ownedRows = await ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(ownedRows).toHaveLength(0);
			const anonymizedRows = await ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_user', (q) => q.eq('userId', '[deleted account]'))
				.collect();
			expect(anonymizedRows).toHaveLength(101);
			expect(anonymizedRows.filter((row) => row.status === 'sent')).toHaveLength(1);
			expect(anonymizedRows.filter((row) => row.status === 'cancelled')).toHaveLength(100);

			const alerts = await ctx.db.query('deliverabilityRegressionAlerts').collect();
			expect(alerts.filter((alert) => alert.emailNotificationState === 'sent')).toHaveLength(1);
			expect(alerts.filter((alert) => alert.emailNotificationState === 'unavailable')).toHaveLength(
				100
			);
			expect(
				alerts
					.filter((alert) => alert.emailNotificationState === 'unavailable')
					.every((alert) => alert.emailNotifiedAt === undefined)
			).toBe(true);
		});
	});

	it('is a clean no-op (still completes the request) when the member owns no personal data', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-3';
		const profileId = await seedProfile(t, authUserId);
		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'me@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'tok3',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId,
			requestId,
			isAlertErasureDone: true,
			isAlertReceiptErasureDone: true,
		});

		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});

	it("revokes the departing member's platform-admin grant", async () => {
		// The row is keyed by BetterAuth user id, not by org membership, so
		// nothing else in the erasure walk touches it. Left behind it would keep
		// satisfying `requirePlatformAdmin` for a departed identity — and it
		// carries the email this erasure exists to remove.
		const t = newHarness();
		const authUserId = 'auth-user-admin';
		const profileId = await seedProfile(t, authUserId);
		const requestId = await t.run(async (ctx) => {
			await ctx.db.insert('platformAdmins', {
				authUserId,
				email: 'me@example.com',
				role: 'superadmin',
				createdAt: Date.now(),
			});
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'me@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'tok-admin',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId,
			requestId,
			isAlertErasureDone: true,
			isAlertReceiptErasureDone: true,
		});

		const left = await t.run(async (ctx) => ctx.db.query('platformAdmins').collect());
		expect(left).toEqual([]);
	});

	it('purges staged export leases, artifacts, and blobs in bounded member-erasure hops', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-export-staging';
		const profileId = await seedProfile(t, authUserId);
		const { requestId, storageIds } = await t.run(async (ctx) => {
			const now = Date.now();
			const requestId = await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'staging@example.com',
				requestedAt: now,
				scheduledForDeletion: now,
				cancellationToken: 'staging-token',
				status: 'pending',
				createdAt: now,
			});
			const sessionId = await ctx.db.insert('accountExportSessions', {
				userId: authUserId,
				artifactCount: 26,
				artifactBytes: 26,
				leaseCount: 26,
				createdAt: now,
				expiresAt: now + 60_000,
			});
			const storageIds: Id<'_storage'>[] = [];
			for (let index = 0; index < 26; index += 1) {
				const storageId = await ctx.storage.store(new Blob([new Uint8Array([index])]));
				storageIds.push(storageId);
				const artifactId = await ctx.db.insert('accountExportArtifacts', {
					sessionId,
					artifactKey: `artifact-${index}`,
					storageId,
					contentLength: 1,
					activeLeaseCount: 1,
					createdAt: now,
				});
				await ctx.db.insert('accountExportArtifactLeases', {
					sessionId,
					artifactId,
					leaseToken: `lease-${index}`,
					createdAt: now,
				});
			}
			return { requestId, storageIds };
		});

		await drainWalk(t, authUserId, requestId);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('accountExportSessions').collect()).toHaveLength(0);
			expect(await ctx.db.query('accountExportArtifacts').collect()).toHaveLength(0);
			expect(await ctx.db.query('accountExportArtifactLeases').collect()).toHaveLength(0);
			for (const storageId of storageIds) expect(await ctx.storage.get(storageId)).toBeNull();
		});
	});
});
