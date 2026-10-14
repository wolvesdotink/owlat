/**
 * Migration 0069 (#1322): one sweep over the knowledge that existed when it
 * started. Every member-visible entry a historical dedup merge could have
 * written into (content on more than one line) is restricted, whatever its
 * source and whether any capture still exists; a single-line entry from an
 * uploaded file is opened to members; one from a capture or a gone file stays
 * restricted. No Message-ID is used to widen a capture. Pages are bounded by
 * bytes as well as rows, always advance, and are recorded in the ledger.
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
import { MIGRATION, PAGE_SIZE, sweepPage } from '../0069_restrict_captured_file_knowledge';
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

describe('0069_restrict_captured_file_knowledge', () => {
	it('restricts every multi-line member-visible entry and opens single-line upload knowledge', async () => {
		const t = convexTest(schema, modules);
		const upload = await file(t, { sourceType: 'upload' });
		const capture = await file(t, { captureSource: 'team_inbox' });
		const gone = await file(t, { sourceType: 'upload' });
		await t.run((ctx) => ctx.db.delete(gone));

		const ids = {
			upload: await entry(t, { sourceType: 'file', sourceId: upload, content: 'Open fact' }),
			uploadMultiLine: await entry(t, {
				sourceType: 'file',
				sourceId: upload,
				content: 'Upload fact\nfolded in',
			}),
			capture: await entry(t, { sourceType: 'file', sourceId: capture, content: 'Private' }),
			orphan: await entry(t, { sourceType: 'file', sourceId: gone, content: 'Orphan' }),
			// No capture, no contact link left: a multi-line survivor is restricted anyway.
			manualMultiLine: await entry(t, {
				sourceType: 'manual',
				content: 'Survivor\nprivate fact from a capture',
			}),
			chatMultiLine: await entry(t, { sourceType: 'chat', content: 'Chat\nfolded' }),
			manual: await entry(t, { sourceType: 'manual', content: 'One plain fact' }),
			teamInbox: await entry(t, { sourceType: 'agent_extracted', content: 'Team\nfact' }),
		};
		tick();
		await t.mutation(migration.run, {});
		tick();
		// Written after the walk started: this release's own write, left alone.
		const later = await entry(t, { sourceType: 'manual', content: 'Written\nafter' });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await read(t, ids.upload)).memberAccess).toBe('members');
		for (const key of [
			'uploadMultiLine',
			'capture',
			'orphan',
			'manualMultiLine',
			'chatMultiLine',
		] as const) {
			const row = await read(t, ids[key]);
			expect(row.memberAccess, key).toBe('restricted');
			expect(isInboxDerivedKnowledge(row), key).toBe(true);
		}
		const plain = await read(t, ids.manual);
		expect(plain.memberAccess).toBeUndefined();
		expect(isInboxDerivedKnowledge(plain)).toBe(false);
		// Already restricted by its source: nothing to write.
		expect((await read(t, ids.teamInbox)).memberAccess).toBeUndefined();
		expect((await read(t, later)).memberAccess).toBeUndefined();

		await t.run(async (ctx) => {
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.first();
			expect(run?.status).toBe('completed');
		});
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
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
		tick();
		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			for (const id of [unmarked, postbox]) {
				const row = (await ctx.db.get(id))!;
				expect(row.sourceMailboxId).toBeUndefined();
			}
			expect((await ctx.db.get(unmarked))!.captureSource).toBeUndefined();
		});
	});

	it('bounds a page by bytes: rows with full embeddings split across pages that always advance', async () => {
		const t = convexTest(schema, modules);
		const upload = await file(t, { sourceType: 'upload' });
		const embedding = Array.from({ length: 1536 }, (_, i) => i / 1536);
		const ids: Id<'knowledgeEntries'>[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push(
				await entry(t, { sourceType: 'file', sourceId: upload, content: `fact ${i}`, embedding })
			);
		}
		tick();
		const cutoff = Date.now();

		// Two rows' worth of bytes: the page stops short of PAGE_SIZE rows.
		const maxBytes = 2 * 1536 * 8;
		let cursor: string | null = null;
		let pages = 0;
		for (;;) {
			const result = await t.run((ctx) => sweepPage(ctx, { cutoff, cursor, maxBytes }));
			pages++;
			expect(result.scanned).toBeLessThan(PAGE_SIZE);
			if (result.isDone) break;
			// A page cut short by bytes still takes at least one row.
			expect(result.scanned).toBeGreaterThan(0);
			expect(result.continueCursor).not.toBe(cursor);
			cursor = result.continueCursor;
		}
		expect(pages).toBeGreaterThan(1);
		for (const id of ids) expect((await read(t, id)).memberAccess).toBe('members');
	});
});
