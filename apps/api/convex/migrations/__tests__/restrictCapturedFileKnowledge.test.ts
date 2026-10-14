/**
 * Migration 0069 (#1322): legacy captures are matched to their source where
 * the Message-ID names one place; knowledge from an upload is opened to
 * members again, knowledge from a capture or a deleted file stays restricted,
 * and member-visible entries a historical merge could have reached are
 * restricted. Over several pages, idempotent and recorded in the ledger.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { MIGRATION } from '../0069_restrict_captured_file_knowledge';
import { isInboxDerivedKnowledge } from '../../inbox/access';

const migration = internal.migrations[MIGRATION];
type T = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

type FileFields = Partial<
	Pick<
		Doc<'semanticFiles'>,
		'sourceType' | 'captureSource' | 'sourceMailboxId' | 'sourceMessageId' | 'contactIds'
	>
>;

const file = (t: T, fields: FileFields) =>
	t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			filename: 'f.txt',
			mimeType: 'text/plain',
			fileSize: 1,
			sourceType: fields.sourceType ?? 'email_attachment',
			...fields,
			version: 1,
			embedding: [],
			createdAt: 1,
			updatedAt: 1,
		})
	);

const entry = (
	t: T,
	fields: Pick<Doc<'knowledgeEntries'>, 'sourceType' | 'content'> &
		Partial<Pick<Doc<'knowledgeEntries'>, 'sourceId' | 'contactIds'>>
) =>
	t.run(async (ctx) => {
		const id = await ctx.db.insert('knowledgeEntries', {
			entryType: 'fact',
			title: fields.content,
			embedding: [],
			confidence: 0.8,
			lastValidatedAt: 1,
			createdAt: 1,
			updatedAt: 1,
			...fields,
		});
		for (const contactId of fields.contactIds ?? []) {
			await ctx.db.insert('knowledgeEntryContacts', { entryId: id, contactId });
		}
		return id;
	});

const contact = (t: T, email: string) =>
	t.run((ctx) =>
		ctx.db.insert('contacts', {
			email,
			source: 'api',
			doiStatus: 'not_required',
			createdAt: 1,
			updatedAt: 1,
		})
	);

async function runToEnd(t: T) {
	await t.mutation(migration.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe('0069_restrict_captured_file_knowledge', () => {
	it('matches unrecorded captures to one source by Message-ID, and only to one', async () => {
		const t = convexTest(schema, modules);
		const mailboxA = await seedMailbox(t, { address: 'a@owlat.test' });
		const mailboxB = await seedMailbox(t, { address: 'b@owlat.test', userId: 'user-B' });
		await seedFolder(t, mailboxA);
		await seedFolder(t, mailboxB);
		await seedMessage(t, mailboxA, { rfc822MessageId: 'only-a@example.com' });
		await seedMessage(t, mailboxA, { rfc822MessageId: 'both@example.com' });
		await seedMessage(t, mailboxB, { rfc822MessageId: 'both@example.com' });
		await t.run((ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: '<team@example.com>',
				from: 'x@example.com',
				to: 'support@owlat.test',
				subject: 's',
				processingStatus: 'received',
				receivedAt: 1,
			})
		);
		const toA = await file(t, { sourceMessageId: '<only-a@example.com>' });
		const toTeam = await file(t, { sourceMessageId: '<team@example.com>' });
		const ambiguous = await file(t, { sourceMessageId: '<both@example.com>' });
		const unknown = await file(t, { sourceMessageId: '<nowhere@example.com>' });
		const postboxNoMailbox = await file(t, {
			captureSource: 'mailbox',
			sourceMessageId: '<only-a@example.com>',
		});
		// A recorded Team Inbox capture is never re-pointed at a mailbox.
		const team = await file(t, {
			captureSource: 'team_inbox',
			sourceMessageId: '<only-a@example.com>',
		});

		await runToEnd(t);

		const source = (id: Id<'semanticFiles'>) =>
			t.run(async (ctx) => {
				const row = (await ctx.db.get(id))!;
				return { captureSource: row.captureSource, sourceMailboxId: row.sourceMailboxId };
			});
		expect(await source(toA)).toEqual({ captureSource: 'mailbox', sourceMailboxId: mailboxA });
		expect(await source(toTeam)).toEqual({
			captureSource: 'team_inbox',
			sourceMailboxId: undefined,
		});
		expect(await source(ambiguous)).toEqual({
			captureSource: undefined,
			sourceMailboxId: undefined,
		});
		expect(await source(unknown)).toEqual({ captureSource: undefined, sourceMailboxId: undefined });
		expect(await source(postboxNoMailbox)).toEqual({
			captureSource: 'mailbox',
			sourceMailboxId: mailboxA,
		});
		expect(await source(team)).toEqual({ captureSource: 'team_inbox', sourceMailboxId: undefined });
	});

	it('opens upload knowledge, restricts capture, orphan and merge-suspect knowledge, across pages', async () => {
		const t = convexTest(schema, modules);
		const sender = await contact(t, 'sender@example.com');
		const other = await contact(t, 'other@example.com');
		const upload = await file(t, { sourceType: 'upload' });
		const capture = await file(t, { captureSource: 'team_inbox', contactIds: [sender] });
		const unmarked = await file(t, {});
		const gone = await file(t, { sourceType: 'upload' });
		await t.run((ctx) => ctx.db.delete(gone));

		const fromUpload = await entry(t, { sourceType: 'file', sourceId: upload, content: 'u' });
		const fromCapture = await entry(t, { sourceType: 'file', sourceId: capture, content: 'c' });
		const fromUnmarked = await entry(t, { sourceType: 'file', sourceId: unmarked, content: 'm' });
		const orphan = await entry(t, {
			sourceType: 'file',
			sourceId: gone,
			content: 'o',
			contactIds: [other],
		});
		// The sender's entries a historical merge could have reached: a merged
		// survivor carries the loser's content on a new line.
		const merged = await entry(t, {
			sourceType: 'manual',
			content: 'Survivor fact\nprivate fact from a capture',
			contactIds: [sender],
		});
		const singleLine = await entry(t, {
			sourceType: 'manual',
			content: 'One plain fact',
			contactIds: [sender],
		});
		// A deleted file's contact is a suspect contact too.
		const otherMerged = await entry(t, {
			sourceType: 'chat',
			content: 'Other survivor\nfolded',
			contactIds: [other],
		});
		// More upload knowledge than one page.
		const many: Id<'knowledgeEntries'>[] = [];
		for (let i = 0; i < 45; i++) {
			many.push(await entry(t, { sourceType: 'file', sourceId: upload, content: `u${i}` }));
		}

		await runToEnd(t);

		const access = (id: Id<'knowledgeEntries'>) => t.run(async (ctx) => (await ctx.db.get(id))!);
		expect((await access(fromUpload)).memberAccess).toBe('members');
		for (const id of many) expect((await access(id)).memberAccess).toBe('members');
		for (const id of [fromCapture, fromUnmarked, orphan, merged, otherMerged]) {
			const row = await access(id);
			expect(row.memberAccess, row.content).toBe('restricted');
			expect(isInboxDerivedKnowledge(row)).toBe(true);
		}
		const plain = await access(singleLine);
		expect(plain.memberAccess).toBeUndefined();
		expect(isInboxDerivedKnowledge(plain)).toBe(false);

		await t.run(async (ctx) => {
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.first();
			expect(run?.status).toBe('completed');
		});
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
