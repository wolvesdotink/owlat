/**
 * Spam triage coverage: reportSpam / notSpam move + restamp the verdict, and
 * blockSender creates a high-priority filter for the sender.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

async function seed(t: ReturnType<typeof convexTest>) {
	let mailboxId!: Id<'mailboxes'>;
	let inboxId!: Id<'mailFolders'>;
	let spamId!: Id<'mailFolders'>;
	let messageId!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const mkFolder = (role: 'inbox' | 'spam') =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name: role,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		inboxId = await mkFolder('inbox');
		spamId = await mkFolder('spam');
		const storageId = await ctx.storage.store(new Blob(['raw']));
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 's',
			participants: ['spammer@bad.example'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 's',
			latestFromAddress: 'spammer@bad.example',
			latestSubject: 's',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: inboxId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m@bad.example>',
			threadId,
			fromAddress: 'spammer@bad.example',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 's',
			normalizedSubject: 's',
			snippet: 's',
			rawStorageId: storageId,
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
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { mailboxId, inboxId, spamId, messageId };
}

describe('postbox spam triage', () => {
	it('reportSpam moves to Spam and stamps the verdict; notSpam restores it', async () => {
		const t = convexTest(schema, modules);
		const { spamId, inboxId, messageId } = await seed(t);

		// Returns { ok } on success so the bulk-actions composable clears the
		// selection (a void return reads as failure and leaves rows checked).
		expect(
			await t.mutation(api.mail.messageActions.reportSpam, { messageIds: [messageId] })
		).toEqual({ ok: true });
		let msg = await t.run((ctx) => ctx.db.get(messageId));
		expect(msg?.folderId).toBe(spamId);
		expect(msg?.spamVerdict).toBe('spam');

		expect(
			await t.mutation(api.mail.messageActions.notSpam, { messageIds: [messageId] })
		).toEqual({ ok: true });
		msg = await t.run((ctx) => ctx.db.get(messageId));
		expect(msg?.folderId).toBe(inboxId);
		expect(msg?.spamVerdict).toBe('ham');
	});

	it('blockSender creates a filter for the sender and moves the message to Spam', async () => {
		const t = convexTest(schema, modules);
		const { spamId, messageId } = await seed(t);

		await t.mutation(api.mail.messageActions.blockSender, { messageId });

		const filters = await t.run((ctx) =>
			ctx.db.query('mailFilters').collect()
		);
		expect(filters.length).toBe(1);
		expect(filters[0]!.conditions[0]).toMatchObject({
			field: 'from',
			op: 'contains',
			value: 'spammer@bad.example',
		});
		const msg = await t.run((ctx) => ctx.db.get(messageId));
		expect(msg?.folderId).toBe(spamId);
	});
});
