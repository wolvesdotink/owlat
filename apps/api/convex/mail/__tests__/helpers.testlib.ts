/**
 * Shared scaffolding for the `mail/*` Convex tests.
 *
 * `modules` is the filtered + re-rooted `import.meta.glob` map convex-test
 * needs, and `seedMailbox` inserts a `mailboxes` row. Both were previously
 * copied verbatim between `permissions.test.ts` and `mailboxAccess.test.ts`.
 *
 * The per-file `vi.mock('../../lib/sessionOrganization', …)` stays local to
 * each test (it hoists a file-scoped mock fn), so this module deliberately
 * exports no session helpers.
 *
 * The `.testlib.ts` (double-dot) name keeps Convex from bundling this file:
 * its entry-point filter skips any basename with more than one dot, which is
 * also how the sibling `*.test.ts` specs are excluded. A single-dot name would
 * be pushed to the deployment, where `import.meta.glob` crashes the isolate.
 */

import type { TestConvex } from 'convex-test';
import type { Id } from '../../_generated/dataModel';
import schema from '../../schema';

// The node-only / agent modules can't load in the test isolate; filter them
// out. Sibling `mail/*` modules glob in as `../foo.ts` (this dir is
// `mail/__tests__/`); convex-test resolves function paths from the convex
// root, so re-root them to `../../mail/foo.ts` — otherwise a
// `t.query(api.mail.…)` can't find the module.
const allModules = import.meta.glob('../../**/*.*s');

export const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
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
				!path.includes('agent/steps/clarify') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

export type MailboxSeed = {
	userId?: string;
	organizationId?: string;
	address?: string;
	domain?: string;
	status?: 'active' | 'suspended' | 'deleted';
	scope?: 'personal' | 'shared';
	kind?: 'hosted' | 'external';
};

/** Insert a `mailboxes` row and return its id. */
export async function seedMailbox(
	t: TestConvex<typeof schema>,
	seed: MailboxSeed = {}
): Promise<Id<'mailboxes'>> {
	let id!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailboxes', {
			userId: seed.userId ?? 'user-A',
			organizationId: seed.organizationId ?? 'org-1',
			address: seed.address ?? 'a@hinterland.camp',
			domain: seed.domain ?? 'hinterland.camp',
			...(seed.scope ? { scope: seed.scope } : {}),
			...(seed.kind ? { kind: seed.kind } : {}),
			status: seed.status ?? 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

/** System folder roles a seeded mailbox can be given. */
export type SeededFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';

/** Insert one system folder (default: the inbox) into a seeded mailbox. */
export async function seedFolder(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	role: SeededFolderRole = 'inbox'
): Promise<Id<'mailFolders'>> {
	let id!: Id<'mailFolders'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: role.toUpperCase(),
			role,
			uidNext: 1,
			uidValidity: now,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

export type MessageSeed = {
	subject?: string;
	snippet?: string;
	fromAddress?: string;
	fromName?: string;
	receivedAt?: number;
	/** Which system folder to file it in — the folder must already be seeded. */
	role?: SeededFolderRole;
	/** Split inbox (idea 24): the named section a `pinToSection` filter claimed it for. */
	pinnedSection?: string;
	/** Seed the row already read — the per-section unread counts need both states. */
	flagSeen?: boolean;
	/** RFC 5322 Message-ID, for the cross-surface correlation (idea 31). */
	rfc822MessageId?: string;
	/** Inline plain-text body — what the deep-search backfill (idea 32) reads. */
	textBodyInline?: string;
	/** Pre-populated deep-search excerpt (idea 32), as a completed backfill leaves it. */
	searchBody?: string;
	/** Attachment metadata as it sits on the row (NOT the junction index). */
	attachments?: {
		filename: string;
		contentType: string;
		size: number;
		contentId?: string;
		partIndex: string;
	}[];
};

/**
 * Insert one queryable message (plus its thread) into a seeded mailbox's
 * folder. Enough of a row to be found by the search index and rendered as a
 * result; not a substitute for the real delivery path.
 */
export async function seedMessage(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	seed: MessageSeed = {}
): Promise<Id<'mailMessages'>> {
	const subject = seed.subject ?? 'hello';
	const snippet = seed.snippet ?? subject;
	const receivedAt = seed.receivedAt ?? Date.now();
	const fromAddress = seed.fromAddress ?? 'someone@example.com';
	let id!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', mailboxId).eq('role', seed.role ?? 'inbox')
			)
			.first();
		if (!folder) throw new Error(`folder ${seed.role ?? 'inbox'} missing — seed it first`);
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: subject,
			participants: [fromAddress],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: receivedAt,
			firstMessageAt: receivedAt,
			latestSnippet: snippet,
			latestFromAddress: fromAddress,
			latestSubject: subject,
			folderRoles: [folder.role ?? 'inbox'],
			labelIds: [],
			createdAt: receivedAt,
			updatedAt: receivedAt,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		id = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: folder._id,
			uid: 1,
			modseq: 1,
			rfc822MessageId: seed.rfc822MessageId ?? `<${subject}-${receivedAt}@example.com>`,
			threadId,
			fromAddress,
			...(seed.fromName ? { fromName: seed.fromName } : {}),
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject,
			normalizedSubject: subject,
			snippet,
			...(seed.textBodyInline ? { textBodyInline: seed.textBodyInline } : {}),
			...(seed.searchBody ? { searchBody: seed.searchBody } : {}),
			rawStorageId,
			rawSize: 3,
			attachments: seed.attachments ?? [],
			hasAttachments: (seed.attachments?.length ?? 0) > 0,
			...(seed.pinnedSection ? { pinnedSection: seed.pinnedSection } : {}),
			flagSeen: seed.flagSeen ?? false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt,
			internalDate: receivedAt,
			createdAt: receivedAt,
			updatedAt: receivedAt,
		});
	});
	return id;
}
