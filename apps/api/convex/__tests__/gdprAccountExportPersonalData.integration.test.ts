/**
 * accountManagement.exportUserData — the personal-data mirror of the right to
 * access: the caller's own mailbox, mail, drafts, external account and chat
 * with secrets and blob handles redacted, empty sections for a member who
 * owns none, and recipient history paginated past one export page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { isSealedBytesAtRest } from '../lib/atRestBodies';
import { sealBodyAtWrite } from '../lib/messageBody';
import { storeSealedBlob } from '../lib/sealedBlob';
import { resetSessionMock } from './gdprSessionMock';
import {
	EXPORT_TEST_SECRET,
	EXPORT_TEST_SITE,
	tamperSealedTextBody,
	newHarness,
	seedProfile,
	seedOrg,
	seedMember,
	seedDeliverabilityAlertRecipients,
	exportAllUserData,
} from './gdprAccountFixtures';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

beforeEach(resetSessionMock);
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('accountManagement.exportUserData — personal data (right-to-access mirror)', () => {
	it("includes the caller's own mailbox, mail, drafts, external account and chat, with secrets/blob handles redacted", async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');
		await seedDeliverabilityAlertRecipients(t, 'auth-user-1', 1);

		await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				address: 'me@example.com',
				domain: 'example.com',
				status: 'suspended' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('mailboxes', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				address: 'team@example.com',
				domain: 'example.com',
				scope: 'shared',
				status: 'active',
				usedBytes: 0,
				uidValidity: now + 1,
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
				participants: ['me@example.com'],
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
			const encoder = new TextEncoder();
			const rawStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('raw eml bytes'),
				'message/rfc822'
			);
			const textBodyStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('storage-backed text body'),
				'text/plain'
			);
			const htmlBodyStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('<p>storage-backed html body</p>'),
				'text/html'
			);
			const missingStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('deleted before export'),
				'text/plain'
			);
			await ctx.storage.delete(missingStorageId);
			const validBeforeTamperingId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('tamper this ciphertext'),
				'text/html'
			);
			const validBeforeTampering = await ctx.storage.get(validBeforeTamperingId);
			const tamperedBytes = new Uint8Array(await validBeforeTampering!.arrayBuffer());
			const finalByteIndex = tamperedBytes.length - 1;
			tamperedBytes[finalByteIndex] = tamperedBytes[finalByteIndex]! ^ 1;
			const corruptStorageId = await ctx.storage.store(
				new Blob([tamperedBytes as unknown as BlobPart], { type: 'text/html' })
			);
			await ctx.storage.delete(validBeforeTamperingId);
			const corruptInlineBody = tamperSealedTextBody(
				await sealBodyAtWrite('tamper this inline body')
			);
			const messageFields = {
				mailboxId,
				folderId,
				modseq: 1,
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				normalizedSubject: 'personal subject',
				snippet: 'personal body snippet',
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
			};
			await ctx.db.insert('mailMessages', {
				...messageFields,
				uid: 1,
				rfc822MessageId: '<m1@example.com>',
				subject: 'personal subject',
				rawStorageId,
				textBodyStorageId,
				htmlBodyStorageId,
			});
			await ctx.db.insert('mailMessages', {
				...messageFields,
				uid: 2,
				rfc822MessageId: '<m2@example.com>',
				subject: 'partially unavailable message',
				rawStorageId: missingStorageId,
				textBodyStorageId: corruptStorageId,
				htmlBodyInline: corruptInlineBody,
			});
			const draftAttachmentStorageId = await ctx.storage.store(
				new Blob(['draft attachment bytes'], { type: 'text/plain' })
			);
			await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['draft-recipient@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: 'draft subject',
				bodyHtml: await sealBodyAtWrite('<p>draft body</p>'),
				bodyText: await sealBodyAtWrite('draft text body'),
				attachments: [
					{
						storageId: draftAttachmentStorageId,
						filename: 'notes.txt',
						contentType: 'text/plain',
						size: 22,
						isInline: false,
					},
				],
				state: 'draft' as const,
				lastEditedAt: now,
				createdAt: now,
			});
			await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['draft-recipient@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: 'corrupt draft',
				bodyHtml: corruptInlineBody,
				attachments: [],
				state: 'draft' as const,
				lastEditedAt: now + 1,
				createdAt: now,
			});
			await ctx.db.insert('externalMailAccounts', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				mailboxId,
				imapHost: 'imap.example.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example.com',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: 'me@example.com',
				secretCiphertext: 'super-secret-ciphertext',
				secretIv: 'super-secret-iv',
				secretAuthTag: 'super-secret-tag',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel' as const,
				name: 'general',
				normalizedName: 'general',
				visibility: 'public' as const,
				createdBy: 'auth-user-1',
				lastMessageAt: now,
				messageCount: 2,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'auth-user-1',
				text: 'my chat message',
				createdAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'someone-else',
				text: 'not my message',
				createdAt: now,
			});
		});

		const stagedContentUrls: string[] = [];
		const res = await exportAllUserData(t, 'auth-user-1', (url) => stagedContentUrls.push(url));

		// Personal sections are populated for the caller's own data.
		expect(res.personalData.mailboxes).toHaveLength(1);
		expect(res.personalData.mailboxes[0]!['status']).toBe('suspended');
		expect(res.personalData.mailMessages).toHaveLength(2);
		const completeMessage = res.personalData.mailMessages.find(
			(message) => message['subject'] === 'personal subject'
		);
		expect(completeMessage).toMatchObject({
			rawMessage: btoa('raw eml bytes'),
			rawMessageEncoding: 'base64',
			textBody: 'storage-backed text body',
			htmlBody: '<p>storage-backed html body</p>',
			bodyAvailability: { raw: 'available', text: 'available', html: 'available' },
		});
		const partialMessage = res.personalData.mailMessages.find(
			(message) => message['subject'] === 'partially unavailable message'
		);
		expect(partialMessage).toMatchObject({
			rawMessage: '',
			rawMessageEncoding: 'base64',
			textBody: '',
			htmlBody: '',
			bodyAvailability: { raw: 'missing', text: 'corrupt', html: 'corrupt' },
		});
		expect(res.personalData.mailDrafts).toHaveLength(2);
		const completeDraft = res.personalData.mailDrafts.find(
			(draft) => draft['subject'] === 'draft subject'
		);
		expect(completeDraft).toMatchObject({
			bodyHtml: '<p>draft body</p>',
			bodyText: 'draft text body',
			bodyAvailability: { html: 'available', text: 'available', blocks: 'missing' },
			attachments: [
				{
					filename: 'notes.txt',
					contentBase64: btoa('draft attachment bytes'),
					isContentAvailable: true,
				},
			],
		});
		const corruptDraft = res.personalData.mailDrafts.find(
			(draft) => draft['subject'] === 'corrupt draft'
		);
		expect(corruptDraft).toMatchObject({
			bodyHtml: '',
			bodyAvailability: { html: 'corrupt', text: 'missing', blocks: 'missing' },
			attachments: [],
		});
		expect(res.personalData.externalMailAccounts).toHaveLength(1);

		// Chat: only the caller's own authorship is exported, not others'.
		expect(res.personalData.chatMessages).toHaveLength(1);
		expect(res.personalData.chatMessages[0]!['text']).toBe('my chat message');
		expect(res.personalData.deliverabilityAlertRecipientStates).toHaveLength(1);
		expect(res.personalData.deliverabilityAlertRecipientStates[0]!['state']).toMatchObject({
			userId: 'auth-user-1',
			status: 'sent',
			attemptCount: 1,
		});
		expect(res.personalData.deliverabilityAlertRecipientStates[0]!['state']).not.toHaveProperty(
			'email'
		);

		// Redaction: storage-blob handles and the encrypted credential envelope
		// never appear in the bundle.
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('rawStorageId');
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('textBodyStorageId');
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('htmlBodyStorageId');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretCiphertext');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretIv');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretAuthTag');

		const serialized = JSON.stringify(res);
		expect(serialized).not.toContain('super-secret-ciphertext');
		expect(serialized).not.toContain('super-secret-iv');
		expect(serialized).not.toContain('super-secret-tag');

		expect(stagedContentUrls).toHaveLength(4);
		for (const contentUrl of stagedContentUrls) {
			const storageId = new URL(contentUrl).searchParams.get('id') as Id<'_storage'> | null;
			expect(storageId).not.toBeNull();
			const storedBytes = new Uint8Array(
				await t.run(async (ctx) => {
					const blob = await ctx.storage.get(storageId!);
					return await blob!.arrayBuffer();
				})
			);
			expect(isSealedBytesAtRest(storedBytes)).toBe(true);
			const storedText = new TextDecoder().decode(storedBytes);
			expect(storedText).not.toContain('raw eml bytes');
			expect(storedText).not.toContain('draft attachment bytes');
		}
	});

	it('returns empty personal-data sections when the caller owns no mail or chat', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.personalData.mailboxes).toHaveLength(0);
		expect(res.personalData.mailMessages).toHaveLength(0);
		expect(res.personalData.mailDrafts).toHaveLength(0);
		expect(res.personalData.externalMailAccounts).toHaveLength(0);
		expect(res.personalData.chatMessages).toHaveLength(0);
		expect(res.personalData.deliverabilityAlertRecipientStates).toHaveLength(0);
	});

	it('paginates recipient history beyond one export page without truncation', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		await seedDeliverabilityAlertRecipients(t, 'auth-user-1', 101);

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.personalData.deliverabilityAlertRecipientStates).toHaveLength(101);
	});

	// REGRESSION (#821). A deliverability seed and a team inbox both name the
	// admin who connected them as `userId`, but both are org infrastructure. The
	// export used to list the seed mailbox as personal and then fail on its
	// messages page (the per-mailbox reads refuse a seed), and the manifest
	// counted account rows the export never wrote.
	it('leaves seed and team-inbox rows out, and the manifest counts match the export', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@owlat.example');

		const personalMailboxId = await t.run(async (ctx) => {
			const now = Date.now();
			const account = {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				imapHost: 'imap.owlat.example',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.owlat.example',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			};
			const insertMailbox = async (address: string, scope?: 'shared' | 'seed') =>
				await ctx.db.insert('mailboxes', {
					userId: 'auth-user-1',
					organizationId: 'org-x',
					address,
					domain: address.split('@')[1]!,
					kind: 'external' as const,
					...(scope ? { scope } : {}),
					status: 'active' as const,
					usedBytes: 0,
					uidValidity: now,
					createdAt: now,
					updatedAt: now,
				});

			const personalMailboxId = await insertMailbox('me@owlat.example');
			await ctx.db.insert('externalMailAccounts', {
				...account,
				mailboxId: personalMailboxId,
				imapUsername: 'me@owlat.example',
			});
			const teamMailboxId = await insertMailbox('team@owlat.example', 'shared');
			await ctx.db.insert('externalMailAccounts', {
				...account,
				mailboxId: teamMailboxId,
				imapUsername: 'team@owlat.example',
			});
			const seedMailboxId = await insertMailbox('owlat.seed.01@gmail.example', 'seed');
			await ctx.db.insert('externalMailAccounts', {
				...account,
				mailboxId: seedMailboxId,
				imapUsername: 'owlat.seed.01@gmail.example',
				purpose: 'seed' as const,
				seedProvider: 'gmail' as const,
			});
			return personalMailboxId;
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.personalData.mailboxes.map((m) => m._id)).toEqual([personalMailboxId]);
		expect(res.personalData.externalMailAccounts.map((a) => a['imapUsername'])).toEqual([
			'me@owlat.example',
		]);

		const plan = await t.action(api.auth.accountExport.getExportPlan, { userId: 'auth-user-1' });
		const count = (resource: string) =>
			plan.personal.find((entry) => entry.resource === resource)?.count;
		expect(count('mailboxes')).toBe(res.personalData.mailboxes.length);
		expect(count('externalMailAccounts')).toBe(res.personalData.externalMailAccounts.length);
	});
});
