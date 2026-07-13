/**
 * Sealed Mail E8b — the sealed-at-rest migration (`migrations/0035`).
 *
 * NAMED TEST GATE:
 *   (b) MIGRATION interrupt/resume — walk `inboundMessages` one page at a time,
 *       stopping between pages, and prove EVERY row is readable at EVERY step
 *       (a half-migrated table is a mix of sealed + plaintext rows and both
 *       decrypt to the canary). Resuming from the returned cursor finishes with
 *       no row ever unreadable and no double-sealing.
 *   (d) CANARY CHECK — after the orchestrator seals every body-bearing table AND
 *       the mailMessages STORAGE BLOBS (raw `.eml` + body blobs), a raw dump of
 *       the seeded convex-test instance — both the DB body columns AND the stored
 *       blob bytes — contains the body canary NOWHERE (all ciphertext); the
 *       plaintext search-index exception (`mailMessages.snippet`) is not asserted
 *       against. Each sealed blob still unseals back to the canary.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { openAtRest, isSealedAtRest, openBytesAtRest } from '../lib/atRestBodies';

const SECRET = 'test-instance-secret-value-for-aes-256-gcm-kdf';
const CANARY = 'CANARY-body-plaintext-9f3a-do-not-leak';

const allModules = import.meta.glob('../**/*.*s');

const migration = internal.migrations['0035_seal_bodies_at_rest'];

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
});

async function seedInbound(t: ReturnType<typeof convexTest>, count: number): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < count; i++) {
			await ctx.db.insert('inboundMessages', {
				messageId: `<m-${i}@example.com>`,
				from: 'sender@example.com',
				to: 'me@example.com',
				subject: `subject ${i}`,
				textBody: `${CANARY} text ${i}`,
				htmlBody: `<p>${CANARY} html ${i}</p>`,
				processingStatus: 'received',
				receivedAt: now,
			});
		}
	});
}

/** Read every inbound row and assert each body decrypts back to the canary. */
async function assertAllInboundReadable(t: ReturnType<typeof convexTest>): Promise<void> {
	const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) {
		const text = await openAtRest(SECRET, row.textBody ?? '');
		const html = await openAtRest(SECRET, row.htmlBody ?? '');
		expect(text).toContain(CANARY);
		expect(html).toContain(CANARY);
	}
}

describe('E8b migration — interrupt/resume (b)', () => {
	it('keeps every row readable across a paginated, resumable seal walk', async () => {
		const t = convexTest(schema, allModules);
		// 120 rows > one PAGE_SIZE (50) → at least three pages, so an interrupt
		// genuinely lands with a mix of sealed and plaintext rows.
		await seedInbound(t, 120);

		// Before migration: all plaintext, all readable.
		await assertAllInboundReadable(t);

		// Page 1 — then STOP (interrupt). Some rows sealed, most still plaintext.
		const p1 = await t.mutation(migration.sealInboundMessagesPage, { cursor: null });
		expect(p1.isDone).toBe(false);
		expect(p1.sealed).toBeGreaterThan(0);
		await assertAllInboundReadable(t); // no row unreadable mid-run

		// RESUME from the returned cursor — page 2, stop again.
		const p2 = await t.mutation(migration.sealInboundMessagesPage, { cursor: p1.cursor });
		await assertAllInboundReadable(t);

		// Drain the rest.
		let cursor = p2.cursor;
		let isDone = p2.isDone;
		while (!isDone) {
			const next = await t.mutation(migration.sealInboundMessagesPage, { cursor });
			cursor = next.cursor;
			isDone = next.isDone;
			await assertAllInboundReadable(t);
		}

		// Every row now sealed AND still readable.
		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		for (const row of rows) {
			expect(isSealedAtRest(row.textBody ?? '')).toBe(true);
			expect(isSealedAtRest(row.htmlBody ?? '')).toBe(true);
		}
		await assertAllInboundReadable(t);
	});

	it('re-running a page is idempotent (no double-seal)', async () => {
		const t = convexTest(schema, allModules);
		await seedInbound(t, 10);
		await t.mutation(migration.sealInboundMessagesPage, { cursor: null });
		const rows1 = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		// Re-run the same first page — already-sealed rows are skipped.
		const rerun = await t.mutation(migration.sealInboundMessagesPage, { cursor: null });
		expect(rerun.sealed).toBe(0);
		const rows2 = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		for (let i = 0; i < rows1.length; i++) {
			expect(rows2[i]!.textBody).toBe(rows1[i]!.textBody);
		}
	});
});

describe('E8b migration — canary dump has zero body plaintext (d)', () => {
	it('seals every body-bearing table so a DB dump holds no body plaintext', async () => {
		const t = convexTest(schema, allModules);
		const now = Date.now();

		// Seed one row in each of the four body-bearing shapes with the canary.
		const ids = await t.run(async (ctx) => {
			await ctx.db.insert('inboundMessages', {
				messageId: '<in@example.com>',
				from: 'a@example.com',
				to: 'me@example.com',
				subject: 's',
				textBody: `${CANARY} inbound text`,
				htmlBody: `<p>${CANARY} inbound html</p>`,
				processingStatus: 'received',
				receivedAt: now,
			});

			const mailboxId = await ctx.db.insert('mailboxes', {
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
			const folderId = await ctx.db.insert('mailFolders', {
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
				normalizedSubject: 's',
				participants: ['a@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 's',
				latestFromAddress: 'a@example.com',
				latestSubject: 's',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			// STORAGE BLOBS carry the canary too: the raw `.eml` and the
			// over-threshold body blobs. The migration must seal these so a STORAGE
			// dump (not just a DB dump) holds no plaintext.
			const rawEml = `${CANARY} raw .eml bytes\r\nSubject: ...\r\n`;
			const rawStorageId = await ctx.storage.store(new Blob([rawEml], { type: 'message/rfc822' }));
			const textBodyStorageId = await ctx.storage.store(
				new Blob([`${CANARY} mail blob text`], { type: 'text/plain; charset=utf-8' })
			);
			const htmlBodyStorageId = await ctx.storage.store(
				new Blob([`<p>${CANARY} mail blob html</p>`], { type: 'text/html; charset=utf-8' })
			);
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<m@example.com>',
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 's',
				normalizedSubject: 's',
				snippet: 'plaintext snippet stays plaintext (search exception)',
				rawStorageId,
				rawSize: rawEml.length,
				textBodyStorageId,
				htmlBodyStorageId,
				textBodyInline: `${CANARY} mail inline text`,
				htmlBodyInline: `<p>${CANARY} mail inline html</p>`,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
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

			const convThreadId = await ctx.db.insert('conversationThreads', {
				subject: 's',
				normalizedSubject: 's',
				contactIdentifier: 'a@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			await ctx.db.insert('unifiedMessages', {
				threadId: convThreadId,
				channel: 'email',
				direction: 'inbound',
				content: JSON.stringify({ text: `${CANARY} unified body` }),
				status: 'received',
				createdAt: now,
			});

			await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['x@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: 's',
				bodyHtml: `<p>${CANARY} draft html</p>`,
				bodyText: `${CANARY} draft text`,
				attachments: [],
				state: 'draft',
				lastEditedAt: now,
				createdAt: now,
			});
			return { mailboxId };
		});
		expect(ids.mailboxId).toBeDefined();

		// Run the whole migration.
		await t.action(migration.run, {});

		// DUMP: read every body-bearing table and assert the canary appears in NO
		// body column. `snippet` (the plaintext search exception) is excluded.
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('inboundMessages').collect()) {
				expect(row.textBody ?? '').not.toContain(CANARY);
				expect(row.htmlBody ?? '').not.toContain(CANARY);
			}
			for (const row of await ctx.db.query('mailMessages').collect()) {
				expect(row.textBodyInline ?? '').not.toContain(CANARY);
				expect(row.htmlBodyInline ?? '').not.toContain(CANARY);
			}
			for (const row of await ctx.db.query('unifiedMessages').collect()) {
				expect(row.content).not.toContain(CANARY);
			}
			for (const row of await ctx.db.query('mailDrafts').collect()) {
				expect(row.bodyHtml).not.toContain(CANARY);
				expect(row.bodyText ?? '').not.toContain(CANARY);
			}
		});

		// STORAGE DUMP: read every mailMessages storage blob (raw `.eml` + body
		// blobs) and assert the canary appears in NONE of them — the storage half of
		// the acceptance bar. Then assert each sealed blob still decrypts back.
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('mailMessages').collect()) {
				const blobIds = [row.rawStorageId, row.textBodyStorageId, row.htmlBodyStorageId].filter(
					(id): id is NonNullable<typeof id> => id !== undefined
				);
				expect(blobIds.length).toBeGreaterThan(0);
				for (const id of blobIds) {
					const blob = await ctx.storage.get(id);
					const bytes = new Uint8Array(await blob!.arrayBuffer());
					// A raw storage dump of the sealed blob holds no canary plaintext…
					expect(new TextDecoder().decode(bytes)).not.toContain(CANARY);
					// …but unsealing with the instance key restores it.
					const opened = await openBytesAtRest(SECRET, bytes);
					expect(new TextDecoder().decode(opened)).toContain(CANARY);
				}
			}
		});

		// And every sealed body still decrypts back to the canary.
		await t.run(async (ctx) => {
			const inbound = await ctx.db.query('inboundMessages').first();
			expect(await openAtRest(SECRET, inbound!.textBody ?? '')).toContain(CANARY);
			const unified = await ctx.db.query('unifiedMessages').first();
			expect(await openAtRest(SECRET, unified!.content)).toContain(CANARY);
			const draft = await ctx.db.query('mailDrafts').first();
			expect(await openAtRest(SECRET, draft!.bodyHtml)).toContain(CANARY);
		});

		// Idempotent re-run seals nothing more.
		const rerun = await t.action(migration.run, {});
		expect(rerun.sealed.inboundMessages).toBe(0);
		expect(rerun.sealed.mailMessages).toBe(0);
		expect(rerun.sealed.unifiedMessages).toBe(0);
		expect(rerun.sealed.mailDrafts).toBe(0);
		expect(rerun.sealed.mailBlobs).toBe(0);
	});
});
