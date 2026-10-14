/**
 * Migration 0069 (#1322): one sweep over the knowledge that existed when it
 * started. A historical dedup merge may have folded captured or Team Inbox
 * text, tags or contact links into any member-visible entry of any source
 * type, and nothing on an entry proves it did not, so every member-visible
 * entry and every file-derived entry becomes owner/admin-only (Marcel,
 * 2026-10-14). Nothing is opened; entries written after the walk started are
 * left to the write-time rules. No Message-ID widens a capture. Pages are
 * bounded by entries and bytes, always advance, and are recorded in the ledger
 * with a start time a second `run` cannot move.
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
import {
	MIGRATION,
	PAGE_BYTES,
	PAGE_SIZE,
	sweepPage,
	type SweepPosition,
} from '../0069_restrict_captured_file_knowledge';
import { isInboxDerivedKnowledge } from '../../inbox/access';

const migration = internal.migrations[MIGRATION];
type T = TestConvex<typeof schema>;

beforeEach(() => {
	// Only the scheduler's timers: creation times and the walk's start time are real.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
	vi.useRealTimers();
});

/** Let the wall clock move past every row written so far. */
function tick(): void {
	const until = Date.now() + 3;
	while (Date.now() < until) {
		// spin
	}
}

const file = (t: T, fields: Partial<Doc<'semanticFiles'>>) =>
	t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			filename: 'f.txt',
			mimeType: 'text/plain',
			fileSize: 1,
			sourceType: 'email_attachment',
			version: 1,
			embedding: [],
			createdAt: 1,
			updatedAt: 1,
			...fields,
		})
	);

const entry = (
	t: T,
	fields: Pick<Doc<'knowledgeEntries'>, 'sourceType' | 'content'> & Partial<Doc<'knowledgeEntries'>>
) =>
	t.run((ctx) =>
		ctx.db.insert('knowledgeEntries', {
			entryType: 'fact',
			title: fields.content,
			embedding: [],
			confidence: 0.8,
			lastValidatedAt: 1,
			createdAt: 1,
			updatedAt: 1,
			...fields,
		})
	);

const read = (t: T, id: Id<'knowledgeEntries'>) => t.run(async (ctx) => (await ctx.db.get(id))!);

async function runToEnd(t: T): Promise<void> {
	tick();
	await t.mutation(migration.run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function ledger(t: T) {
	return t.run(
		async (ctx) =>
			(await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.first())!
	);
}

describe('0069_restrict_captured_file_knowledge', () => {
	it('restricts every member-visible entry of every source type, and every file-derived one', async () => {
		const t = convexTest(schema, modules);
		const upload = await file(t, { sourceType: 'upload' });
		const capture = await file(t, { captureSource: 'team_inbox' });
		const contactId = await t.run((ctx) =>
			ctx.db.insert('contacts', {
				email: 'c@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: 1,
				updatedAt: 1,
			})
		);

		const restricted = {
			// Proven from an upload at write time: a merge could still have reached it.
			uploadOpened: await entry(t, {
				sourceType: 'file',
				sourceId: upload,
				content: 'Upload fact',
				memberAccess: 'members',
			}),
			uploadUnmarked: await entry(t, { sourceType: 'file', sourceId: upload, content: 'U' }),
			capture: await entry(t, { sourceType: 'file', sourceId: capture, content: 'Private' }),
			email: await entry(t, { sourceType: 'email', content: 'From imported mail' }),
			chat: await entry(t, { sourceType: 'chat', content: 'From chat' }),
			manual: await entry(t, { sourceType: 'manual', content: 'Hand-written fact' }),
			curated: await entry(t, {
				sourceType: 'curated',
				content: 'Refunds within 30 days.',
				isAuthoritative: true,
			}),
			// (a) A merge appended private text on a new line; an edit since put it
			// on one line. The text is still there, and nothing shows the merge.
			editedSurvivor: await entry(t, {
				sourceType: 'manual',
				content: 'Survivor fact and the private fact from a capture',
				updatedAt: 5,
			}),
			// (b) A merge that only added a private tag and a contact link: the
			// survivor already contained the loser's text, so no newline either.
			taggedSurvivor: await entry(t, {
				sourceType: 'manual',
				content: 'Plain fact',
				tags: ['acme-acquisition'],
				contactIds: [contactId],
				updatedAt: 5,
			}),
		};
		// Already kept from members by their source: left as they are.
		const teamInbox = await entry(t, { sourceType: 'agent_extracted', content: 'Team fact' });

		await runToEnd(t);

		for (const [key, id] of Object.entries(restricted)) {
			const row = await read(t, id);
			expect(row.memberAccess, key).toBe('restricted');
			expect(isInboxDerivedKnowledge(row), key).toBe(true);
		}
		const team = await read(t, teamInbox);
		expect(team.memberAccess).toBeUndefined();
		expect(isInboxDerivedKnowledge(team)).toBe(true);

		const run = await ledger(t);
		expect(run.status).toBe('completed');
		expect(run.changedCount).toBe(Object.keys(restricted).length);
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});

	it('(c) leaves entries written after the walk started to the write-time rules', async () => {
		const t = convexTest(schema, modules);
		const upload = await file(t, { sourceType: 'upload' });
		const old = await entry(t, { sourceType: 'manual', content: 'Old fact' });
		tick();
		await t.mutation(migration.run, {});
		tick();
		const later = {
			manual: await entry(t, { sourceType: 'manual', content: 'New\nmulti-line fact' }),
			upload: await entry(t, {
				sourceType: 'file',
				sourceId: upload,
				content: 'New upload fact',
				memberAccess: 'members',
			}),
		};
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await read(t, old)).memberAccess).toBe('restricted');
		expect((await read(t, later.manual)).memberAccess).toBeUndefined();
		expect(isInboxDerivedKnowledge(await read(t, later.manual))).toBe(false);
		expect((await read(t, later.upload)).memberAccess).toBe('members');
	});

	it('never widens a capture by its Message-ID', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: 'a@owlat.test' });
		await seedFolder(t, mailboxId);
		// A message in mailbox A with the capture's Message-ID: not proof of origin.
		await seedMessage(t, mailboxId, { rfc822MessageId: 'reused@example.com' });
		const unmarked = await file(t, { sourceMessageId: '<reused@example.com>' });
		const postbox = await file(t, {
			captureSource: 'mailbox',
			sourceMessageId: '<reused@example.com>',
		});
		await runToEnd(t);

		await t.run(async (ctx) => {
			for (const id of [unmarked, postbox]) {
				expect((await ctx.db.get(id))!.sourceMailboxId).toBeUndefined();
			}
			expect((await ctx.db.get(unmarked))!.captureSource).toBeUndefined();
		});
	});

	it('bounds a page by bytes: rows with full embeddings split across pages that always advance', async () => {
		const t = convexTest(schema, modules);
		const embedding = Array.from({ length: 1536 }, (_, i) => i / 1536);
		const ids: Id<'knowledgeEntries'>[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push(await entry(t, { sourceType: 'manual', content: `fact ${i}`, embedding }));
		}
		tick();
		const cutoff = Date.now();

		// Two rows' worth of bytes: the page stops short of PAGE_SIZE rows.
		const maxBytes = 2 * 1536 * 8;
		let after: SweepPosition | null = null;
		let pages = 0;
		for (;;) {
			const result = await t.run((ctx) => sweepPage(ctx, { cutoff, after, maxBytes }));
			pages++;
			expect(result.scanned).toBeLessThan(PAGE_SIZE);
			if (result.isDone) break;
			// A page cut short by bytes still takes at least one row.
			expect(result.scanned).toBeGreaterThan(0);
			expect(result.after).not.toEqual(after);
			after = result.after;
		}
		expect(pages).toBeGreaterThan(1);
		for (const id of ids) expect((await read(t, id)).memberAccess).toBe('restricted');
	});

	it('keeps every page under a transaction when entries are near the 1 MiB document limit', async () => {
		const t = convexTest(schema, modules);
		const text = 'x'.repeat(1_000_000);
		const ids: Id<'knowledgeEntries'>[] = [];
		for (let i = 0; i < 24; i++) {
			ids.push(await entry(t, { sourceType: 'manual', content: `fact ${i} ${text}` }));
		}
		tick();
		const cutoff = Date.now();

		let after: SweepPosition | null = null;
		let pages = 0;
		for (;;) {
			const result = await t.run((ctx) => sweepPage(ctx, { cutoff, after }));
			pages++;
			// The budget, plus the peeked entry and the resume anchor re-read.
			expect(result.bytesRead).toBeLessThan(PAGE_BYTES + 2 * 1024 * 1024);
			expect(result.bytesRead).toBeLessThan(16 * 1024 * 1024);
			if (result.isDone) break;
			expect(result.scanned).toBeGreaterThan(0);
			after = result.after;
		}
		expect(pages).toBeGreaterThan(2);
		for (const id of ids) expect((await read(t, id)).memberAccess).toBe('restricted');
	});

	it('keeps the start time when run is called again before the first page commits', async () => {
		const t = convexTest(schema, modules);
		const before = await entry(t, { sourceType: 'manual', content: 'Old fact' });
		tick();
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: true });
		const { startedAt } = await ledger(t);
		tick();
		// Written by this release after the walk started, before its first page ran.
		const after = await entry(t, { sourceType: 'manual', content: 'New fact' });
		tick();
		// A second run before any page committed resumes the same walk.
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const run = await ledger(t);
		expect(run.startedAt).toBe(startedAt);
		expect(run.status).toBe('completed');
		expect((await read(t, before)).memberAccess).toBe('restricted');
		expect((await read(t, after)).memberAccess).toBeUndefined();
	});
});
