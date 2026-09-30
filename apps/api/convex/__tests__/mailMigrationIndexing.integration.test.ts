import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GenericActionCtx, GenericMutationCtx } from 'convex/server';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { DataModel, Id } from '../_generated/dataModel';
import { internalAction } from '../_generated/server';
import { v } from 'convex/values';
import { createTestKnowledgeEntry, enableFeatures } from './factories';

// The ctx shape convex-test hands to `t.run` (a mutation ctx plus storage).
type SeedCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, 'storage'>;

// Session helpers are unused by the internal indexer fns, but the module graph
// imports them transitively — stub to a stable owner identity.
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

// `knowledge/extraction` is `'use node'` and pulls in LLM/embedding deps. The
// indexer is tested via the skip path (pre-create knowledgeEntries with
// sourceType:'email') so `extractFromMailMessage` is never invoked from tests.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
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
			!path.includes('knowledge/extraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

// For the screening tests: the same graph with a stand-in extractor that records
// which messages reached it instead of calling an LLM.
const extracted: string[] = [];
const modulesWithExtractorStub = {
	...modules,
	'../knowledge/extraction.ts': async () => ({
		extractFromMailMessage: internalAction({
			args: {
				mailMessageId: v.id('mailMessages'),
				contactIds: v.optional(v.array(v.id('contacts'))),
			},
			handler: async (_ctx, args) => {
				extracted.push(args.mailMessageId);
			},
		}),
	}),
};

// Suppress "Could not find module" rejections from the scheduler trying to run
// the excluded extraction action — the skip path means it's never reached, but
// guard defensively like the inbound backfill test does.
const suppressedErrors: Error[] = [];
const unhandledRejectionHandler = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressedErrors.push(err);
	} else {
		throw err;
	}
};

beforeEach(() => {
	suppressedErrors.length = 0;
	process.on('unhandledRejection', unhandledRejectionHandler);
});

afterEach(() => {
	process.removeListener('unhandledRejection', unhandledRejectionHandler);
});

// ── Seed helpers ───────────────────────────────────────────────────────────

interface Seeded {
	mailboxId: Id<'mailboxes'>;
	folderId: Id<'mailFolders'>;
	threadId: Id<'mailThreads'>;
	accountId: Id<'externalMailAccounts'>;
}

async function seedMailbox(ctx: SeedCtx): Promise<Seeded> {
	const now = Date.now();
	const mailboxId = (await ctx.db.insert('mailboxes', {
		userId: 'test-user',
		organizationId: 'org-1',
		address: 'me@imported.test',
		domain: 'imported.test',
		kind: 'external',
		status: 'active',
		usedBytes: 0,
		uidValidity: now,
		createdAt: now,
		updatedAt: now,
	})) as Id<'mailboxes'>;
	const accountId = (await ctx.db.insert('externalMailAccounts', {
		userId: 'test-user',
		organizationId: 'org-1',
		mailboxId,
		imapHost: 'imap.gmail.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 465,
		isSmtpSecure: true,
		authMethod: 'password',
		imapUsername: 'me@imported.test',
		secretCiphertext: 'x',
		secretIv: 'x',
		secretAuthTag: 'x',
		secretEnvelopeVersion: 1,
		status: 'connected',
		createdAt: now,
		updatedAt: now,
	})) as Id<'externalMailAccounts'>;
	const folderId = (await ctx.db.insert('mailFolders', {
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
	})) as Id<'mailFolders'>;
	const threadId = (await ctx.db.insert('mailThreads', {
		mailboxId,
		normalizedSubject: 'thread',
		participants: [],
		messageCount: 0,
		unreadCount: 0,
		hasFlagged: false,
		hasAttachments: false,
		lastMessageAt: now,
		firstMessageAt: now,
		latestSnippet: '',
		latestFromAddress: '',
		latestSubject: '',
		folderRoles: ['inbox'],
		labelIds: [],
		createdAt: now,
		updatedAt: now,
	})) as Id<'mailThreads'>;
	return { mailboxId, folderId, threadId, accountId };
}

async function seedMessage(
	ctx: SeedCtx,
	s: Seeded,
	overrides: Record<string, unknown> = {}
): Promise<Id<'mailMessages'>> {
	const now = Date.now();
	const rawStorageId = await ctx.storage.store(new Blob(['raw bytes'], { type: 'message/rfc822' }));
	return (await ctx.db.insert('mailMessages', {
		mailboxId: s.mailboxId,
		folderId: s.folderId,
		threadId: s.threadId,
		uid: 1,
		modseq: 1,
		rfc822MessageId: `mid-${Math.random().toString(36).slice(2)}`,
		fromAddress: 'alice@example.com',
		fromName: 'Alice Smith',
		toAddresses: ['me@imported.test'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Hello',
		normalizedSubject: 'hello',
		snippet: 'hello there',
		rawStorageId,
		rawSize: 9,
		textBodyInline: 'This is the body of the imported message about the project.',
		attachments: [],
		hasAttachments: false,
		flagSeen: true,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		labelIds: [],
		receivedAt: 1000,
		internalDate: 1000,
		createdAt: now,
		updatedAt: now,
		...overrides,
	})) as Id<'mailMessages'>;
}

async function seedMigration(
	ctx: SeedCtx,
	s: Seeded,
	overrides: Record<string, unknown> = {}
): Promise<Id<'mailboxMigrations'>> {
	const now = Date.now();
	return (await ctx.db.insert('mailboxMigrations', {
		userId: 'test-user',
		organizationId: 'org-1',
		accountId: s.accountId,
		mailboxId: s.mailboxId,
		source: 'google',
		status: 'indexing',
		isAiIndexingEnabled: true,
		messagesTotal: 0,
		messagesImported: 0,
		messagesIndexed: 0,
		startedAt: now,
		updatedAt: now,
		...overrides,
	})) as Id<'mailboxMigrations'>;
}

// =====================================================================
// resolveSenderContact — quiet find-or-create
// =====================================================================

describe('migrationIndexing.resolveSenderContact', () => {
	it('creates a CRM contact + email identity for a new sender', async () => {
		const t = convexTest(schema, modules);
		const res = await t.mutation(internal.mail.migrationIndexing.resolveSenderContact, {
			email: 'Bob.Jones@Example.com',
			fromName: 'Bob Jones',
		});
		expect(res.contactId).not.toBeNull();
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(res.contactId!);
			expect(contact!.email).toBe('bob.jones@example.com');
			expect(contact!.firstName).toBe('Bob');
			expect(contact!.lastName).toBe('Jones');
			expect(contact!.source).toBe('import');
			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'email').eq('identifier', 'bob.jones@example.com')
				)
				.first();
			expect(identity).not.toBeNull();
		});
	});

	it('dedupes to the same contact on a second resolve (no duplicates)', async () => {
		const t = convexTest(schema, modules);
		const a = await t.mutation(internal.mail.migrationIndexing.resolveSenderContact, {
			email: 'carol@example.com',
		});
		const b = await t.mutation(internal.mail.migrationIndexing.resolveSenderContact, {
			email: 'carol@example.com',
		});
		expect(a.contactId).toEqual(b.contactId);
		await t.run(async (ctx) => {
			const all = await ctx.db.query('contacts').collect();
			expect(all).toHaveLength(1);
		});
	});

	it('returns null for an address with no @ (knowledge lands org-general)', async () => {
		const t = convexTest(schema, modules);
		const res = await t.mutation(internal.mail.migrationIndexing.resolveSenderContact, {
			email: 'mailer-daemon',
		});
		expect(res.contactId).toBeNull();
	});
});

// =====================================================================
// nextIndexChunk — cursor pagination scoped to mailbox
// =====================================================================

describe('migrationIndexing.nextIndexChunk', () => {
	it('pages by receivedAt asc and reports hasMore', async () => {
		const t = convexTest(schema, modules);
		let s!: Seeded;
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			for (let i = 0; i < 3; i++) {
				await seedMessage(ctx, s, { receivedAt: 1000 + i });
			}
		});

		const page1 = await t.query(internal.mail.migrationIndexing.nextIndexChunk, {
			mailboxId: s.mailboxId,
			limit: 2,
		});
		expect(page1.messages).toHaveLength(2);
		expect(page1.hasMore).toBe(true);
		expect(page1.messages[0]!.receivedAt).toBe(1000);

		const page2 = await t.query(internal.mail.migrationIndexing.nextIndexChunk, {
			mailboxId: s.mailboxId,
			cursorReceivedAt: page1.messages[1]!.receivedAt,
			cursorId: page1.messages[1]!._id,
			limit: 2,
		});
		expect(page2.messages).toHaveLength(1);
		expect(page2.hasMore).toBe(false);
		expect(page2.messages[0]!.receivedAt).toBe(1002);
	});

	it('drains a same-receivedAt group larger than the page without skipping or repeating', async () => {
		// Bulk imports cluster messages on one second-precision timestamp. A group
		// bigger than the page size must not wedge the walk (the old fixed
		// over-fetch silently dropped the tail + every later message).
		const t = convexTest(schema, modules);
		let s!: Seeded;
		const ids: Id<'mailMessages'>[] = [];
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			for (let i = 0; i < 5; i++) ids.push(await seedMessage(ctx, s, { receivedAt: 1000 }));
			ids.push(await seedMessage(ctx, s, { receivedAt: 1001 }));
			ids.push(await seedMessage(ctx, s, { receivedAt: 1002 }));
		});

		const seen: Id<'mailMessages'>[] = [];
		let cursorReceivedAt: number | undefined;
		let cursorId: Id<'mailMessages'> | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = await t.query(internal.mail.migrationIndexing.nextIndexChunk, {
				mailboxId: s.mailboxId,
				cursorReceivedAt,
				cursorId,
				limit: 2,
			});
			for (const m of page.messages) seen.push(m._id);
			if (!page.hasMore) break;
			const last = page.messages[page.messages.length - 1]!;
			cursorReceivedAt = last.receivedAt;
			cursorId = last._id;
		}

		expect(seen).toHaveLength(7); // every message, exactly once
		expect(new Set(seen)).toEqual(new Set(ids));
	});
});

// =====================================================================
// runIndexChunk — skip path (idempotency), completion, cursor, gating
// =====================================================================

describe('migrationIndexing.runIndexChunk', () => {
	it('finalizes the migration as completed and counts swept messages', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			// Two imported messages, both already extracted → skip path (no LLM).
			for (let i = 0; i < 2; i++) {
				const msgId = await seedMessage(ctx, s, { receivedAt: 1000 + i });
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ sourceType: 'email', sourceId: msgId })
				);
			}
			migrationId = await seedMigration(ctx, s, { messagesImported: 2 });
		});

		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 30,
			interChunkDelayMs: 0,
		});
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('completed');
			expect(m!.messagesIndexed).toBe(2);
			expect(m!.completedAt).toBeDefined();
		});
	});

	it('advances the cursor and reschedules across multiple chunks', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		const ids: Id<'mailMessages'>[] = [];
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			for (let i = 0; i < 5; i++) {
				const msgId = await seedMessage(ctx, s, { receivedAt: 1000 + i });
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ sourceType: 'email', sourceId: msgId })
				);
				ids.push(msgId);
			}
			migrationId = await seedMigration(ctx, s, { messagesImported: 5 });
		});

		// Drive the chunks directly (each call reads the persisted cursor). This
		// is deterministic and sidesteps the scheduler-drain quirk; the rescheduled
		// chunks each runIndexChunk fires are simply left unrun.

		// Chunk 1 → processes ids[0..1], advances cursor, stays 'indexing'.
		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 2,
			interChunkDelayMs: 0,
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('indexing');
			expect(m!.messagesIndexed).toBe(2);
			expect(m!.indexCursorReceivedAt).toBe(1001);
			expect(m!.indexCursorId).toBe(ids[1]);
		});

		// Chunk 2 → processes ids[2..3].
		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 2,
			interChunkDelayMs: 0,
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('indexing');
			expect(m!.messagesIndexed).toBe(4);
			expect(m!.indexCursorId).toBe(ids[3]);
		});

		// Chunk 3 → consumes the tail (ids[4]) and finalizes.
		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 2,
			interChunkDelayMs: 0,
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('completed');
			expect(m!.messagesIndexed).toBe(5);
		});
	});

	it('stops a chunk that outruns its time budget, keeps its progress and reschedules', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		const ids: Id<'mailMessages'>[] = [];
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			for (let i = 0; i < 6; i++) {
				const msgId = await seedMessage(ctx, s, { receivedAt: 1000 + i });
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ sourceType: 'email', sourceId: msgId })
				);
				ids.push(msgId);
			}
			migrationId = await seedMigration(ctx, s, { messagesImported: 6 });
		});

		// Every Date.now() read jumps 5 minutes: the budget is spent after the
		// first group of four, as if each extraction were a slow LLM call.
		let clock = Date.now();
		const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 5 * 60 * 1000));
		try {
			await t.action(internal.mail.migrationIndexing.runIndexChunk, {
				migrationId,
				chunkSize: 25,
				interChunkDelayMs: 0,
			});
		} finally {
			now.mockRestore();
		}

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('indexing');
			expect(m!.messagesIndexed).toBe(4);
			expect(m!.indexCursorId).toBe(ids[3]);
			const next = (await ctx.db.system.query('_scheduled_functions').collect()).filter((job) =>
				job.name.includes('runIndexChunk')
			);
			expect(next).toHaveLength(1);
		});
	});

	it('completes without indexing when ai.knowledge is disabled', async () => {
		const t = convexTest(schema, modules);
		// ai.knowledge NOT enabled → defaults off.
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			await seedMessage(ctx, s, { receivedAt: 1000 });
			migrationId = await seedMigration(ctx, s, { messagesImported: 1 });
		});

		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 30,
			interChunkDelayMs: 0,
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('completed');
			expect(m!.messagesIndexed).toBe(0);
		});
	});

	it('is a no-op when the migration is not in the indexing phase', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			migrationId = await seedMigration(ctx, s, { status: 'cancelled' });
		});

		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 30,
			interChunkDelayMs: 0,
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('cancelled');
			expect(m!.messagesIndexed).toBe(0);
		});
	});
});

// =====================================================================
// Cancel during the indexing phase must stick (chunk-runner race)
// =====================================================================

describe('migrationIndexing — cancel during indexing is sticky', () => {
	it('finalizeMigration does not resurrect a migration that was cancelled mid-chunk', async () => {
		const t = convexTest(schema, modules);
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			// The user cancelled while a chunk was in flight.
			migrationId = await seedMigration(ctx, s, { status: 'cancelled', completedAt: 1 });
		});

		// The in-flight chunk's final finalize lands after the cancel.
		await t.mutation(internal.mail.migrationIndexing.finalizeMigration, {
			migrationId,
			status: 'completed',
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('cancelled'); // not overwritten back to completed
		});
	});

	it('patchIndexProgress does not advance a cancelled migration', async () => {
		const t = convexTest(schema, modules);
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			migrationId = await seedMigration(ctx, s, { status: 'cancelled' });
		});

		await t.mutation(internal.mail.migrationIndexing.patchIndexProgress, {
			migrationId,
			deltaIndexed: 5,
			cursorReceivedAt: 2000,
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesIndexed).toBe(0);
			expect(m!.indexCursorReceivedAt).toBeUndefined();
		});
	});
});

// =====================================================================
// scope guard — a shared (team inbox) import has no onboarding side effects
// =====================================================================

describe('migrationIndexing — onboarding stamps are personal-only', () => {
	async function onboardingRows(t: ReturnType<typeof convexTest>) {
		return await t.run((ctx) => ctx.db.query('userOnboarding').collect());
	}

	it('finalizeMigration skips knowledgeIndexed for a scope=shared migration', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let shared!: Id<'mailboxMigrations'>;
		let personal!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			const s = await seedMailbox(ctx);
			shared = await seedMigration(ctx, s, { scope: 'shared' });
			personal = await seedMigration(ctx, s);
		});

		// Same terminal transition, same "ran to completion" flag — the team
		// inbox's import stamps nothing, the personal one stamps the step.
		await t.mutation(internal.mail.migrationIndexing.finalizeMigration, {
			migrationId: shared,
			status: 'completed',
			indexingRanToCompletion: true,
		});
		expect(await onboardingRows(t)).toHaveLength(0);

		await t.mutation(internal.mail.migrationIndexing.finalizeMigration, {
			migrationId: personal,
			status: 'completed',
			indexingRanToCompletion: true,
		});
		const rows = await onboardingRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.authUserId).toBe('test-user');
		expect(rows[0]!.knowledgeIndexed).toBeDefined();
	});

	it('a shared sweep still completes and counts its messages', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let s!: Seeded;
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			s = await seedMailbox(ctx);
			for (let i = 0; i < 2; i++) {
				const msgId = await seedMessage(ctx, s, { receivedAt: 1000 + i });
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ sourceType: 'email', sourceId: msgId })
				);
			}
			migrationId = await seedMigration(ctx, s, { scope: 'shared', messagesImported: 2 });
		});

		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 30,
			interChunkDelayMs: 0,
		});
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('completed');
			expect(m!.messagesIndexed).toBe(2);
		});
		expect(await onboardingRows(t)).toHaveLength(0);
	});
});

// =====================================================================
// reindexMigration — operator re-run of a finished import's sweep
// =====================================================================

describe('migrationIndexing.reindexMigration', () => {
	it('re-sweeps a completed import that finished without knowledge', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			const s = await seedMailbox(ctx);
			for (let i = 0; i < 2; i++) {
				const msgId = await seedMessage(ctx, s, { receivedAt: 1000 + i });
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ sourceType: 'email', sourceId: msgId })
				);
			}
			migrationId = await seedMigration(ctx, s, {
				status: 'completed',
				isAiIndexingEnabled: false,
				messagesImported: 2,
				completedAt: Date.now(),
			});
		});

		const res = await t.mutation(internal.mail.migrationIndexing.reindexMigration, {
			migrationId,
		});
		expect(res).toEqual({ started: true });
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('indexing');
			expect(m!.isAiIndexingEnabled).toBe(true);
			expect(m!.messagesIndexed).toBe(0);
		});

		await t.finishAllScheduledFunctions(() => {});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('completed');
			expect(m!.messagesIndexed).toBe(2);
		});
	});

	it('refuses an import that is still running', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			migrationId = await seedMigration(ctx, await seedMailbox(ctx), { status: 'importing' });
		});
		const res = await t.mutation(internal.mail.migrationIndexing.reindexMigration, {
			migrationId,
		});
		expect(res).toEqual({ started: false, reason: 'status_importing' });
	});

	it('refuses while ai.knowledge is off', async () => {
		const t = convexTest(schema, modules);
		let migrationId!: Id<'mailboxMigrations'>;
		await t.run(async (ctx) => {
			migrationId = await seedMigration(ctx, await seedMailbox(ctx), { status: 'completed' });
		});
		const res = await t.mutation(internal.mail.migrationIndexing.reindexMigration, {
			migrationId,
		});
		expect(res).toEqual({ started: false, reason: 'ai_knowledge_disabled' });
	});
});

// =====================================================================
// runIndexChunk — untrusted mail never reaches the extractor
// =====================================================================

describe('migrationIndexing.runIndexChunk — screening', () => {
	it('extracts a normal message but not a phishing one, and counts both', async () => {
		extracted.length = 0;
		const t = convexTest(schema, modulesWithExtractorStub);
		await enableFeatures(t, ['ai.knowledge']);
		let migrationId!: Id<'mailboxMigrations'>;
		let normalId!: Id<'mailMessages'>;
		await t.run(async (ctx) => {
			const s = await seedMailbox(ctx);
			normalId = await seedMessage(ctx, s, { receivedAt: 1000 });
			// Imported from a provider's inbox: no spam verdict on the row.
			await seedMessage(ctx, s, {
				receivedAt: 1001,
				fromAddress: 'support@page-help.example.com',
				fromName: 'Support Team',
				subject: 'Action required: your page will be restricted',
				textBodyInline:
					'Dear user, verify your password within 24 hours or your page will be restricted.',
				htmlBodyInline:
					'<p>Dear user, verify your password within 24 hours or your page will be restricted.</p>' +
					'<a href="https://paypa1.fake.xyz/login">https://www.example.com/support</a>',
			});
			// Clean content, but the From domain spoofs a known contact's.
			await seedMessage(ctx, s, {
				receivedAt: 1002,
				fromAddress: 'bob@examp1e.com',
				senderHeuristics: { lookalikeOfContactDomain: 'example.com' },
			});
			migrationId = await seedMigration(ctx, s, { messagesImported: 3 });
		});

		await t.action(internal.mail.migrationIndexing.runIndexChunk, {
			migrationId,
			chunkSize: 30,
			interChunkDelayMs: 0,
		});

		expect(extracted).toEqual([normalId]);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('completed');
			expect(m!.messagesIndexed).toBe(3);
			const emails = (await ctx.db.query('contacts').collect()).map((c) => c.email);
			expect(emails).toContain('alice@example.com');
			expect(emails).not.toContain('support@page-help.example.com');
			expect(emails).not.toContain('bob@examp1e.com');
		});
	});
});
