/**
 * The deployment the mail-sync wire fixtures describe
 * (`@owlat/worker-protocol/wireFixtures`, `MAIL_SYNC_WIRE_FIXTURES`), seeded row
 * for row, and the bindings from each fixture placeholder to the id it got here.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest, type TestConvex } from 'convex-test';
import {
	MAIL_SYNC_FIXTURE_CREDENTIALS as CREDS,
	MAIL_SYNC_FIXTURE_OAUTH_CREDENTIALS as OAUTH,
	MAIL_SYNC_WIRE_IDS as M,
} from '@owlat/worker-protocol/wireFixtures';
import type { WithoutSystemFields } from 'convex/server';
import type { Doc, Id } from '../../_generated/dataModel';
import schema from '../../schema';
import { enableFeatures } from '../../__tests__/factories';
import { encryptSecret } from '../../lib/credentialCrypto';
import { SEED_PROBE_RETENTION_MS } from '../../schema/seedPlacement';
import { modules } from './helpers.testlib';

const HOUR = 60 * 60 * 1000;

export interface MailSyncWireWorld {
	readonly t: TestConvex<typeof schema>;
	readonly mailboxId: Id<'mailboxes'>;
	readonly accountId: Id<'externalMailAccounts'>;
	readonly oauthAccountId: Id<'externalMailAccounts'>;
	/** An account id whose row is gone. */
	readonly goneAccountId: Id<'externalMailAccounts'>;
	readonly migrationId: Id<'mailboxMigrations'>;
	readonly ops: Record<'move' | 'flags' | 'rename', Id<'externalMailRemoteOps'>>;
	/** Placeholder → the id or value this deployment minted for it. */
	readonly ids: Record<string, string>;
}

export async function seedMailSyncWireWorld(): Promise<MailSyncWireWorld> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['mail.external']);
	const sealed = encryptSecret(
		JSON.stringify({ imapPassword: CREDS.imapPassword, smtpPassword: CREDS.smtpPassword })
	);
	const sealedGrant = encryptSecret(JSON.stringify({ oauthRefreshToken: '1//fixture-refresh' }));
	const seeded = await t.run(async (ctx) => {
		const now = Date.now();
		const mailbox = (address: string) =>
			ctx.db.insert('mailboxes', {
				userId: 'user-fixture',
				organizationId: 'org-fixture',
				address,
				domain: address.split('@')[1]!,
				kind: 'external',
				status: 'active',
				usedBytes: 0,
				uidValidity: 1_700_000_000,
				createdAt: now,
				updatedAt: now,
			});
		const account = (fields: {
			mailboxId: Id<'mailboxes'>;
			creds: typeof CREDS | typeof OAUTH;
			envelope: ReturnType<typeof encryptSecret>;
			authMethod: 'password' | 'oauth2';
			status: 'pending' | 'connected';
			extra?: Record<string, unknown>;
		}) =>
			ctx.db.insert('externalMailAccounts', {
				userId: 'user-fixture',
				organizationId: 'org-fixture',
				mailboxId: fields.mailboxId,
				imapHost: fields.creds.imapHost,
				imapPort: fields.creds.imapPort,
				isImapSecure: fields.creds.isImapSecure,
				smtpHost: fields.creds.smtpHost,
				smtpPort: fields.creds.smtpPort,
				isSmtpSecure: fields.creds.isSmtpSecure,
				authMethod: fields.authMethod,
				imapUsername: fields.creds.imapUsername,
				secretCiphertext: fields.envelope.ciphertext,
				secretIv: fields.envelope.iv,
				secretAuthTag: fields.envelope.authTag,
				secretEnvelopeVersion: fields.envelope.version,
				status: fields.status,
				createdAt: now,
				updatedAt: now,
				...fields.extra,
			});

		const mailboxId = await mailbox(CREDS.imapUsername);
		const accountId = await account({
			mailboxId,
			creds: CREDS,
			envelope: sealed,
			authMethod: 'password',
			status: 'connected',
			extra: { fullSyncAlignedAt: now - HOUR },
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId });
		const oauthMailboxId = await mailbox(OAUTH.imapUsername);
		const oauthAccountId = await account({
			mailboxId: oauthMailboxId,
			creds: OAUTH,
			envelope: sealedGrant,
			authMethod: 'oauth2',
			status: 'pending',
			extra: { oauthProvider: 'google', syncMode: 'incoming' },
		});
		await ctx.db.patch(oauthMailboxId, { externalAccountId: oauthAccountId });
		const goneAccountId = await account({
			mailboxId,
			creds: CREDS,
			envelope: sealed,
			authMethod: 'password',
			status: 'connected',
		});
		await ctx.db.delete(goneAccountId);

		const folder = (name: string, role: 'inbox' | 'archive' | 'sent') =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: 1_700_000_000,
				uidNext: 10,
				highestModseq: 10,
				totalCount: 1,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		const inbox = await folder('INBOX', 'inbox');
		const archive = await folder('Archive', 'archive');
		const sent = await folder('Sent', 'sent');
		await ctx.db.insert('externalMailFolderSync', {
			accountId,
			mailboxId,
			folderId: inbox,
			remoteName: 'INBOX',
			remoteUidValidity: 77,
			lastSeenUid: 120,
			lastSyncedAt: now,
			forwardIngestFailures: [{ uid: 118, attempts: 1 }],
			forwardIngestFailureCount: 2,
		});
		await ctx.db.insert('externalMailFolderSync', {
			accountId,
			mailboxId,
			folderId: archive,
			remoteName: 'Archive',
			remoteUidValidity: 78,
			lastSeenUid: 40,
			lastSyncedAt: now,
		});

		const message = async (fields: {
			folderId: Id<'mailFolders'>;
			role: 'inbox' | 'archive' | 'sent';
			rfc822MessageId: string;
			uid: number;
			flagSeen: boolean;
			flagFlagged: boolean;
			receivedAt: number;
			remoteSighting?: { remoteName: string; uidValidity: number; uid: number };
		}) => {
			const { role, ...row } = fields;
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: row.rfc822MessageId,
				participants: ['ada@example.com'],
				messageCount: 1,
				unreadCount: row.flagSeen ? 0 : 1,
				hasFlagged: row.flagFlagged,
				hasAttachments: false,
				lastMessageAt: row.receivedAt,
				firstMessageAt: row.receivedAt,
				latestSnippet: row.rfc822MessageId,
				latestFromAddress: 'ada@example.com',
				latestSubject: row.rfc822MessageId,
				folderRoles: [role],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw message']));
			await ctx.db.insert('mailMessages', {
				...row,
				mailboxId,
				threadId,
				modseq: 1,
				fromAddress: 'ada@example.com',
				toAddresses: [CREDS.imapUsername],
				ccAddresses: [],
				bccAddresses: [],
				subject: row.rfc822MessageId,
				normalizedSubject: row.rfc822MessageId,
				snippet: row.rfc822MessageId,
				rawStorageId,
				rawSize: 11,
				attachments: [],
				hasAttachments: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				internalDate: row.receivedAt,
				createdAt: now,
				updatedAt: now,
			});
		};
		await message({
			folderId: inbox,
			role: 'inbox',
			rfc822MessageId: 'quarterly-1@example.com',
			uid: 1,
			flagSeen: true,
			flagFlagged: true,
			receivedAt: now - 3 * HOUR,
			remoteSighting: { remoteName: 'INBOX', uidValidity: 77, uid: 101 },
		});
		await message({
			folderId: archive,
			role: 'archive',
			rfc822MessageId: 'reminder-2@example.com',
			uid: 1,
			flagSeen: false,
			flagFlagged: false,
			receivedAt: now - 2 * HOUR,
		});
		await message({
			folderId: sent,
			role: 'sent',
			rfc822MessageId: 'sent-3@owlat.example',
			uid: 1,
			flagSeen: true,
			flagFlagged: false,
			receivedAt: now - HOUR,
		});

		const migrationId = await ctx.db.insert('mailboxMigrations', {
			userId: 'user-fixture',
			organizationId: 'org-fixture',
			accountId,
			mailboxId,
			source: 'imap',
			status: 'importing',
			isAiIndexingEnabled: false,
			messagesTotal: 10,
			messagesImported: 4,
			messagesIndexed: 0,
			startedAt: now - HOUR,
			updatedAt: now - HOUR,
		});

		const op = (
			fields: Omit<
				WithoutSystemFields<Doc<'externalMailRemoteOps'>>,
				'accountId' | 'attempts' | 'createdAt'
			> & { attempts?: number }
		) =>
			ctx.db.insert('externalMailRemoteOps', {
				accountId,
				attempts: 0,
				createdAt: fields.nextAttemptAt,
				...fields,
			});
		const moveOp = await op({
			kind: 'move',
			rfc822MessageId: 'quarterly-1@example.com',
			source: { remote: 'INBOX' },
			target: { role: 'archive' },
			nextAttemptAt: now - 60_000,
		});
		const flagsOp = await op({
			kind: 'flags',
			rfc822MessageId: 'reminder-2@example.com',
			source: { remote: 'Archive' },
			flags: { seen: true, flagged: false },
			attempts: 1,
			nextAttemptAt: now - 30_000,
		});
		const renameOp = await op({
			kind: 'renameFolder',
			source: { remote: 'Projects' },
			target: { path: ['Clients'] },
			nextAttemptAt: now + HOUR,
		});

		const seedMailboxId = await mailbox('seed@gmail.example');
		const seedAccountId = await account({
			mailboxId: seedMailboxId,
			creds: CREDS,
			envelope: sealed,
			authMethod: 'password',
			status: 'connected',
			extra: { purpose: 'seed', seedProvider: 'gmail' },
		});
		const probe = (probeId: string, dispatchedAt: number) =>
			ctx.db.insert('seedPlacementProbes', {
				organizationId: 'org-fixture',
				probeId,
				accountId: seedAccountId,
				provider: 'gmail',
				stream: 'campaign',
				transportArm: 'own',
				dispatchedAt,
				sentAt: dispatchedAt,
				expiresAt: dispatchedAt + SEED_PROBE_RETENTION_MS,
			});
		await probe('probe-settled', now - HOUR / 2);
		await probe('probe-expired', now - 25 * HOUR);

		return {
			mailboxId,
			oauthMailboxId,
			accountId,
			oauthAccountId,
			goneAccountId,
			seedAccountId,
			inbox,
			archive,
			migrationId,
			ops: { move: moveOp, flags: flagsOp, rename: renameOp },
		};
	});
	return {
		t,
		mailboxId: seeded.mailboxId,
		accountId: seeded.accountId,
		oauthAccountId: seeded.oauthAccountId,
		goneAccountId: seeded.goneAccountId,
		migrationId: seeded.migrationId,
		ops: seeded.ops,
		ids: {
			[M.mailbox]: seeded.mailboxId,
			[M.oauthMailbox]: seeded.oauthMailboxId,
			[M.account]: seeded.accountId,
			[M.oauthAccount]: seeded.oauthAccountId,
			[M.seedAccount]: seeded.seedAccountId,
			[M.inbox]: seeded.inbox,
			[M.archive]: seeded.archive,
			[M.migration]: seeded.migrationId,
			[M.moveOp]: seeded.ops.move,
			[M.flagsOp]: seeded.ops.flags,
			[M.renameOp]: seeded.ops.rename,
		},
	};
}
