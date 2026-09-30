import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	type Harness,
	draftRow,
	drainScheduled,
	erasureHarness,
	jobOf,
	requestOf,
	runDeletionCron,
	seedEditor,
	seedIdentity,
	seedMembership,
	seedPersonalMailbox,
	threadRow,
} from './memberErasureFixtures';

/**
 * Issue #942: a completed member erasure leaves no personal data behind —
 * private assistant transcripts and uploaded mail archives included — while
 * other members' data and the organization's shared and seed mailboxes stay.
 * Also the volume half of #940: a mailbox larger than one transaction may read
 * drains over bounded transactions under enforced limits.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedAssistant(t: Harness, ownerId: string) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const conversationId = await ctx.db.insert('aiConversations', {
			ownerId,
			title: 'about my health',
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 2,
		});
		const promptId = await ctx.db.insert('aiMessages', {
			conversationId,
			ownerId,
			role: 'user',
			text: 'a private question',
			status: 'complete',
			createdAt: now,
		});
		const streamingId = await ctx.db.insert('aiMessages', {
			conversationId,
			ownerId,
			role: 'assistant',
			text: 'a partial answ',
			status: 'streaming',
			createdAt: now + 1,
		});
		// One the owner already deleted from the list.
		const hiddenId = await ctx.db.insert('aiConversations', {
			ownerId,
			title: 'deleted earlier',
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 0,
			deletedAt: now,
		});
		return { conversationId, promptId, streamingId, hiddenId };
	});
}

async function seedArchiveImport(t: Harness, authUserId: string, mailboxId: Id<'mailboxes'>) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const storageId = await ctx.storage.store(new Blob(['From x\nSubject: old mail\n\nbody']));
		const importId = await ctx.db.insert('mailArchiveImports', {
			userId: authUserId,
			mailboxId,
			storageId,
			filename: 'takeout.mbox',
			format: 'mbox',
			totalBytes: 34,
			cursorBytes: 0,
			messagesImported: 0,
			messagesSkipped: 0,
			labelsCreated: 0,
			status: 'importing',
			startedAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('storageUploads', {
			userId: authUserId,
			organizationId: 'org-x',
			status: 'bound',
			storageId,
			resourceKey: `mailArchiveImports:${importId}`,
		});
		return { importId, storageId };
	});
}

describe('personal data coverage', () => {
	it('erases assistant transcripts and uploaded archives, and keeps everyone else’s', async () => {
		const t = erasureHarness();
		const { organizationId, authUserId, requestId } = await seedEditor(t);
		const { mailboxId } = await seedPersonalMailbox(t, authUserId);
		const assistant = await seedAssistant(t, authUserId);
		const archive = await seedArchiveImport(t, authUserId, mailboxId);
		await t.run((ctx) =>
			ctx.db.insert('aiDraftStreams', {
				ownerId: authUserId,
				surface: 'compose',
				status: 'complete',
				text: 'a revised private draft',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
		// The organization's team inbox and deliverability seed the member
		// connected, and a colleague's own assistant and mailbox.
		const team = await seedPersonalMailbox(t, authUserId, {
			scope: 'shared',
			address: 'team@example.com',
		});
		const seed = await seedPersonalMailbox(t, authUserId, {
			scope: 'seed',
			address: 'seed@example.com',
		});
		const colleagueId = await seedIdentity(t, 'colleague@example.com');
		await seedMembership(t, organizationId, colleagueId, 'editor');
		const colleagueMailbox = await seedPersonalMailbox(t, colleagueId);
		const colleagueAssistant = await seedAssistant(t, colleagueId);

		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		await t.run(async (ctx) => {
			for (const id of [
				assistant.conversationId,
				assistant.hiddenId,
				assistant.promptId,
				assistant.streamingId,
				archive.importId,
				mailboxId,
			]) {
				expect(await ctx.db.get(id as never), String(id)).toBeNull();
			}
			expect(await ctx.storage.get(archive.storageId)).toBeNull();
			expect(await ctx.db.query('storageUploads').collect()).toHaveLength(0);
			expect(
				await ctx.db
					.query('aiDraftStreams')
					.withIndex('by_owner', (q) => q.eq('ownerId', authUserId))
					.collect()
			).toHaveLength(0);

			// Organization infrastructure and the colleague's data survive.
			for (const kept of [team, seed, colleagueMailbox]) {
				expect(await ctx.db.get(kept.mailboxId)).not.toBeNull();
				expect(await ctx.db.get(kept.messageId)).not.toBeNull();
			}
			expect(await ctx.db.get(colleagueAssistant.conversationId)).not.toBeNull();
			expect(await ctx.db.get(colleagueAssistant.promptId)).not.toBeNull();
		});
	});

	it('an assistant runner or an archive importer racing the erasure cannot write data back', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		const { mailboxId } = await seedPersonalMailbox(t, authUserId);
		const assistant = await seedAssistant(t, authUserId);
		const archive = await seedArchiveImport(t, authUserId, mailboxId);
		await runDeletionCron(t);
		const job = (await jobOf(t, requestId))!;

		// Stop right after the mailbox was quiesced: the importer is mid-archive.
		for (let i = 0; i < 50; i++) {
			if ((await jobOf(t, requestId))?.phase === 'mailboxMessages') break;
			await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
		}
		const staged = await t.run((ctx) => ctx.storage.store(new Blob(['staged eml'])));
		const ingest = await t.mutation(internal.mail.archiveImport.ingestArchiveMessage, {
			importId: archive.importId,
			folderRole: 'inbox',
			from: 'old@example.com',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'resurrected?',
			messageId: '<late@example.com>',
			attachments: [],
			receivedAt: Date.now(),
			rawStorageId: staged,
			rawSize: 10,
		});
		expect(ingest.skipped).toBe(true);
		expect(
			await t.mutation(internal.mail.archiveImport.recordProgress, {
				importId: archive.importId,
				cursorBytes: 34,
				importedDelta: 1,
				skippedDelta: 0,
				labelsCreatedDelta: 0,
			})
		).toEqual({ stillImporting: false });

		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		// The streaming runner's next patch and its finalize find nothing to write.
		expect(
			await t.mutation(internal.assistant.conversations.patchAssistantMessage, {
				messageId: assistant.streamingId,
				text: 'a partial answer, continued',
			})
		).toEqual({ stop: true });
		await t.mutation(internal.assistant.conversations.finalizeAssistantMessage, {
			messageId: assistant.streamingId,
			text: 'the whole answer',
			status: 'complete',
		});
		await t.mutation(internal.mail.archiveImport.finishJob, {
			importId: archive.importId,
			status: 'completed',
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('aiMessages').collect()).toHaveLength(0);
			expect(await ctx.db.query('aiConversations').collect()).toHaveLength(0);
			expect(await ctx.db.query('mailMessages').collect()).toHaveLength(0);
			expect(await ctx.db.query('mailArchiveImports').collect()).toHaveLength(0);
			expect(await ctx.storage.get(staged)).toBeNull();
		});
	});
});

describe('volume under the platform limits', () => {
	// The real ceiling is 32,000 documents read per transaction. convex-test
	// needs minutes to seed and walk that many threads, so the limit is scaled
	// down eightfold with the mailbox: one thread more than a transaction may
	// read. The previous walker collected every thread in one transaction and
	// failed here exactly as it does on a deployment past 32,000.
	it('drains more retained threads than a transaction may read, many drafts and pages of mentions', async () => {
		const DOCUMENTS_READ_LIMIT = 4_000;
		const t = erasureHarness({ documentsRead: DOCUMENTS_READ_LIMIT });
		const { authUserId, requestId } = await seedEditor(t);
		const { mailboxId } = await seedPersonalMailbox(t, authUserId);
		// The seeded mailbox already holds one thread.
		for (let seeded = 1; seeded <= DOCUMENTS_READ_LIMIT; seeded += 1_000) {
			await t.run(async (ctx) => {
				const now = Date.now();
				for (let i = seeded; i < Math.min(DOCUMENTS_READ_LIMIT + 1, seeded + 1_000); i++) {
					await ctx.db.insert('mailThreads', threadRow(mailboxId, now - i));
				}
			});
		}
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 300; i++) {
				const storageId = await ctx.storage.store(new Blob([`attachment ${i}`]));
				await ctx.db.insert('mailDrafts', draftRow(mailboxId, now, [{ storageId }]));
			}
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel' as const,
				name: 'general',
				normalizedName: 'general',
				visibility: 'public' as const,
				createdBy: 'someone-else',
				lastMessageAt: now,
				messageCount: 1,
				createdAt: now,
				updatedAt: now,
			});
			const messageId = await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'someone-else',
				text: 'ping',
				createdAt: now,
			});
			for (let i = 0; i < 600; i++) {
				await ctx.db.insert('chatMentions', {
					roomId,
					messageId,
					mentionedMemberId: authUserId,
					mentioningMemberId: 'someone-else',
					createdAt: now,
				});
			}
		});

		await runDeletionCron(t);
		const job = (await jobOf(t, requestId))!;
		let ticks = 0;
		let outcome = 'more';
		// Every tick runs under the enforced limits and throws if it crosses one.
		while (outcome === 'more' && ticks < 1_000) {
			outcome = await t.mutation(internal.auth.erasure.walker.tick, { jobId: job._id });
			ticks += 1;
		}
		expect(outcome).toBe('done');
		expect(ticks).toBeGreaterThan(10);
		expect((await requestOf(t, requestId))?.status).toBe('completed');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailThreads').first()).toBeNull();
			expect(await ctx.db.query('mailDrafts').first()).toBeNull();
			expect(await ctx.db.query('chatMentions').first()).toBeNull();
			expect(await ctx.db.get(mailboxId)).toBeNull();
		});
	}, 300_000);
});
