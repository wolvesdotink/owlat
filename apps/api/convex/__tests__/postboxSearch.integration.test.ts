/**
 * Mailbox search — operator + free-text coverage.
 *
 * Regression guard for the bug where a free-text term combined with a partial
 * `from:` operator returned zero results: the text branch applied an exact
 * `.eq('fromAddress', token)` on the search index (a substring like "sara"
 * never equals "sara@acme.com"), while the no-text branch used the substring
 * post-filter and worked. Both branches must now honour a partial from-token.
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
		!path.includes('llmProvider')
	)
);

async function seed(t: ReturnType<typeof convexTest>) {
	let mailboxId!: Id<'mailboxes'>;
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
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'project meeting',
			participants: ['sara@acme.com'],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'meeting notes',
			latestFromAddress: 'sara@acme.com',
			latestSubject: 'project meeting',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const storageId = await ctx.storage.store(new Blob(['meeting']));
		await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: inboxId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m1@acme.com>',
			threadId,
			fromAddress: 'sara@acme.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'project meeting',
			normalizedSubject: 'project meeting',
			snippet: 'meeting notes about the launch',
			rawStorageId: storageId,
			rawSize: 7,
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
	return { mailboxId };
}

describe('mail.mailbox.search', () => {
	it('matches free text combined with a partial from-token', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search, {
			mailboxId,
			text: 'meeting',
			from: 'sara',
		});
		expect(results.map((m) => m.subject)).toEqual(['project meeting']);
	});

	it('matches a partial from-token with no free text', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search, {
			mailboxId,
			text: '',
			from: 'sara',
		});
		expect(results.map((m) => m.subject)).toEqual(['project meeting']);
	});

	it('excludes a non-matching from-token', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seed(t);
		const results = await t.query(api.mail.mailbox.search, {
			mailboxId,
			text: 'meeting',
			from: 'bob',
		});
		expect(results).toEqual([]);
	});
});
