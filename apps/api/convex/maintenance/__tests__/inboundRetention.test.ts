/**
 * Inbound-mail file retention — one sweep that releases BYTES and keeps ROWS.
 *
 * Proven here:
 *   · the horizon is the one an admin CONFIGURED, not a constant: a 30-day
 *     setting releases a 45-day-old message and spares a 15-day-old one;
 *   · with nothing configured `DEFAULT_INBOUND_RAW_RETENTION_DAYS` applies;
 *   · a released message keeps everything that is not the blob — messageId,
 *     subject, bodies, attachment metadata, its malware verdict and its SIZE —
 *     and is STAMPED with `rawReleasedAt`, which is the only thing separating
 *     "the window passed" from "the bytes were never carried";
 *   · a released attachment keeps its summary, extracted text and embedding, so
 *     `[RELEVANT FILES]` retrieval survives the sweep;
 *   · an uploaded file of the same age is untouched — and so is a PERSONAL
 *     MAILBOX capture, which shares `sourceType: 'email_attachment'` with the
 *     team inbox and has no horizon of its own;
 *   · the sweep is bounded per tick and resumes, and a second pass over the
 *     same data releases nothing further.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	DEFAULT_INBOUND_RAW_RETENTION_DAYS,
	type InboundRawRetentionDays,
} from '@owlat/shared/inboundRetention';
import { inboundRawRetentionDaysValidator } from '../../lib/literalValidators';

// The `../../**` glob omits the `maintenance/` dir it climbed through, so
// merge a second glob rooted there and re-prefix its keys (see
// inbox/__tests__/draftRevisions.test.ts for the same arrangement).
const rootGlob = import.meta.glob('../../**/*.*s');
const maintenanceGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../maintenance/'),
		mod,
	])
);
const modules = { ...rootGlob, ...maintenanceGlob };

const DAY_MS = 24 * 60 * 60 * 1000;
/** BATCH in maintenance/retention.ts. */
const BATCH = 200;

afterEach(() => {
	vi.useRealTimers();
});

async function setHorizon(
	t: ReturnType<typeof convexTest>,
	days: InboundRawRetentionDays
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			inboundRawRetentionDays: days,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/**
 * Insert an inbound message holding a raw blob, received `ageDays` ago —
 * `extraMs` further back, for the cases that live one millisecond either side
 * of the cutoff.
 */
async function seedInboundMessage(
	t: ReturnType<typeof convexTest>,
	messageId: string,
	now: number,
	ageDays: number,
	extraMs = 0
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(
			new Blob([`raw bytes of ${messageId}`], { type: 'message/rfc822' })
		);
		return await ctx.db.insert('inboundMessages', {
			messageId,
			from: 'bob@example.com',
			to: 'inbox@example.com',
			subject: `subject of ${messageId}`,
			textBody: 'the body stays',
			attachmentMeta: '[{"filename":"notes.txt","contentType":"text/plain","size":9}]',
			processingStatus: 'received',
			receivedAt: now - ageDays * DAY_MS - extraMs,
			rawStorageId: storageId,
			rawSize: 42,
			isRawRetained: true,
			virusVerdict: 'clean',
		});
	});
}

/** Insert a semanticFiles row holding a blob, created `ageDays` ago. */
async function seedSemanticFile(
	t: ReturnType<typeof convexTest>,
	filename: string,
	now: number,
	ageDays: number,
	sourceType: 'email_attachment' | 'upload',
	captureSource?: 'team_inbox' | 'mailbox',
	extraMs = 0
): Promise<Id<'semanticFiles'>> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([`bytes of ${filename}`]));
		return await ctx.db.insert('semanticFiles', {
			storageId,
			filename,
			mimeType: 'text/plain',
			fileSize: 12,
			sourceType,
			captureSource,
			summary: 'a summary that outlives the bytes',
			extractedText: 'extracted text that outlives the bytes',
			embedding: Array.from({ length: 1536 }, () => 0.1),
			version: 1,
			createdAt: now - ageDays * DAY_MS - extraMs,
			updatedAt: now - ageDays * DAY_MS - extraMs,
		});
	});
}

describe('sweepInboundFiles — the raw `.eml` half', () => {
	it('honours the configured horizon rather than a constant', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		const stale = await seedInboundMessage(t, '<stale@example.com>', now, 45);
		const fresh = await seedInboundMessage(t, '<fresh@example.com>', now, 15);
		const staleBlob = await t.run(async (ctx) => (await ctx.db.get(stale))!.rawStorageId!);

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });

		const staleRow = await t.run(async (ctx) => await ctx.db.get(stale));
		// The BLOB is gone.
		expect(staleRow!.rawStorageId).toBeUndefined();
		expect(staleRow!.isRawRetained).toBeUndefined();
		// STAMPED, not erased: without this the reader cannot tell a swept
		// message from one that predates raw storage, and tells both that a
		// retention window expired.
		expect(staleRow!.rawReleasedAt).toBe(now);
		// And the size survives, so the reader can still say how big it was.
		expect(staleRow!.rawSize).toBe(42);
		expect(await t.run(async (ctx) => await ctx.storage.get(staleBlob))).toBeNull();
		// Everything that is not the blob stays.
		expect(staleRow!.messageId).toBe('<stale@example.com>');
		expect(staleRow!.subject).toBe('subject of <stale@example.com>');
		expect(staleRow!.textBody).toBe('the body stays');
		expect(staleRow!.attachmentMeta).toContain('notes.txt');
		expect(staleRow!.virusVerdict).toBe('clean');

		// Inside the horizon: untouched.
		const freshRow = await t.run(async (ctx) => await ctx.db.get(fresh));
		expect(freshRow!.rawStorageId).toBeDefined();
		expect(freshRow!.isRawRetained).toBe(true);
		expect(freshRow!.rawReleasedAt).toBeUndefined();
	});

	it('spares a row AT the cutoff and releases the one a millisecond older', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const days = 30;
		await setHorizon(t, days);
		// `.lt(receivedAt, cutoff)`, on both walks. The suite's other cases sit
		// days away from the horizon, so `.lt` drifting to `.lte` — or the two
		// walks disagreeing with each other — changes nothing they can see.
		const atCutoff = await seedInboundMessage(t, '<at@example.com>', now, days);
		const justOlder = await seedInboundMessage(t, '<older@example.com>', now, days, 1);
		const fileAtCutoff = await seedSemanticFile(
			t,
			'at.txt',
			now,
			days,
			'email_attachment',
			'team_inbox'
		);
		const fileJustOlder = await seedSemanticFile(
			t,
			'older.txt',
			now,
			days,
			'email_attachment',
			'team_inbox',
			1
		);

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });

		const rows = await t.run(async (ctx) => ({
			at: await ctx.db.get(atCutoff),
			older: await ctx.db.get(justOlder),
			fileAt: await ctx.db.get(fileAtCutoff),
			fileOlder: await ctx.db.get(fileJustOlder),
		}));
		// Exactly at the horizon is still INSIDE it: the message received
		// `days` ago to the millisecond keeps its bytes until the next tick.
		expect(rows.at!.rawStorageId).toBeDefined();
		expect(rows.at!.rawReleasedAt).toBeUndefined();
		expect(rows.older!.rawStorageId).toBeUndefined();
		expect(rows.older!.rawReleasedAt).toBe(now);
		// The attachment walk keeps the SAME edge as the raw walk.
		expect(rows.fileAt!.storageId).toBeDefined();
		expect(rows.fileAt!.bytesReleasedAt).toBeUndefined();
		expect(rows.fileOlder!.storageId).toBeUndefined();
		expect(rows.fileOlder!.bytesReleasedAt).toBe(now);
	});

	it('falls back to the shared default when nothing is configured', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const insideAge = DEFAULT_INBOUND_RAW_RETENTION_DAYS - 1;
		const outsideAge = DEFAULT_INBOUND_RAW_RETENTION_DAYS + 1;
		const inside = await seedInboundMessage(t, '<inside@example.com>', now, insideAge);
		const outside = await seedInboundMessage(t, '<outside@example.com>', now, outsideAge);

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });

		// Read whole rows back: a bare `undefined` returned across the `t.run`
		// boundary serializes to `null`, which would make the assertion about the
		// wrong thing.
		const insideRow = await t.run(async (ctx) => await ctx.db.get(inside));
		const outsideRow = await t.run(async (ctx) => await ctx.db.get(outside));
		expect(insideRow!.rawStorageId).toBeDefined();
		expect(outsideRow!.rawStorageId).toBeUndefined();
	});

	it('is bounded per tick and resumes until the backlog drains', async () => {
		// `finishInProgressScheduledFunctions` only drains what is already
		// running; the sweep's `runAfter(0)` follow-up is still PENDING then, so
		// the drain assertion would pass vacuously. Fake timers must be installed
		// BEFORE the first mutation so the scheduler sees the fake clock.
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);

		for (let i = 0; i < BATCH + 1; i++) {
			await seedInboundMessage(t, `<stale-${i}@example.com>`, now, 45);
		}
		const fresh = await seedInboundMessage(t, '<fresh@example.com>', now, 5);

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });
		// One tick cannot have finished: the batch came back full.
		const afterFirst = await t.run(async (ctx) =>
			(await ctx.db.query('inboundMessages').collect()).filter((r) => r.isRawRetained === true)
		);
		expect(afterFirst).toHaveLength(BATCH + 2 - BATCH);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();

		const retained = await t.run(async (ctx) =>
			(await ctx.db.query('inboundMessages').collect()).filter((r) => r.isRawRetained === true)
		);
		// Only the row inside the horizon still holds bytes.
		expect(retained).toHaveLength(1);
		expect(retained[0]!._id).toBe(fresh);
	});
});

describe('sweepInboundFiles — the attachment half', () => {
	it('releases an aged email attachment while keeping what retrieval needs', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		const stale = await seedSemanticFile(t, 'stale.txt', now, 45, 'email_attachment', 'team_inbox');
		const staleBlob = await t.run(async (ctx) => (await ctx.db.get(stale))!.storageId!);

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });

		const row = await t.run(async (ctx) => await ctx.db.get(stale));
		expect(row!.storageId).toBeUndefined();
		expect(row!.bytesReleasedAt).toBe(now);
		expect(await t.run(async (ctx) => await ctx.storage.get(staleBlob))).toBeNull();
		// Retrieval still works: the row keeps everything the search reads.
		expect(row!.summary).toBe('a summary that outlives the bytes');
		expect(row!.extractedText).toBe('extracted text that outlives the bytes');
		expect(row!.embedding).toHaveLength(1536);
	});

	it('leaves a non-attachment file of the same age alone', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		const upload = await seedSemanticFile(t, 'upload.txt', now, 45, 'upload');

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });

		const row = await t.run(async (ctx) => await ctx.db.get(upload));
		// A file a user uploaded is theirs; this sweep is about mail we received.
		expect(row!.storageId).toBeDefined();
		expect(row!.bytesReleasedAt).toBeUndefined();
	});

	it('leaves a PERSONAL-MAILBOX capture of the same age alone', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		// Both routes write `sourceType: 'email_attachment'` — `captureAttachments`
		// is shared — so `sourceType` alone cannot tell them apart. A horizon an
		// admin set for the SHARED INBOX must not strip the file-library blobs of
		// Postbox mail, which keeps its own raw `.eml` permanently and has no
		// horizon at all.
		const postbox = await seedSemanticFile(
			t,
			'postbox.pdf',
			now,
			45,
			'email_attachment',
			'mailbox'
		);
		const teamInbox = await seedSemanticFile(
			t,
			'inbox.pdf',
			now,
			45,
			'email_attachment',
			'team_inbox'
		);

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });

		const postboxRow = await t.run(async (ctx) => await ctx.db.get(postbox));
		expect(postboxRow!.storageId).toBeDefined();
		expect(postboxRow!.bytesReleasedAt).toBeUndefined();
		// The team-inbox sibling of the same age WAS released, so this is a
		// scoping assertion rather than a sweep that did nothing.
		const inboxRow = await t.run(async (ctx) => await ctx.db.get(teamInbox));
		expect(inboxRow!.storageId).toBeUndefined();
	});

	it('releases nothing further on a second pass over the same data', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		const stale = await seedSemanticFile(t, 'stale.txt', now, 45, 'email_attachment', 'team_inbox');

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, { now });
		const firstPass = (await t.run(async (ctx) => await ctx.db.get(stale)))!.bytesReleasedAt;

		// A second run a day later must not re-stamp the row: an already-released
		// row falls out of the index range, which is what terminates the walk.
		await t.mutation(internal.maintenance.retention.sweepInboundFiles, {
			now: now + DAY_MS,
		});
		const secondPass = (await t.run(async (ctx) => await ctx.db.get(stale)))!.bytesReleasedAt;
		expect(secondPass).toBe(firstPass);
	});
});

describe('the retention horizon choices', () => {
	it('has a default an admin can actually choose', () => {
		// The validator is DERIVED from `INBOUND_RAW_RETENTION_DAY_CHOICES`, so
		// the two cannot disagree and nothing here needs to check that they do.
		// What derivation does not give you is this: a default outside the
		// offered set is a setting nobody can put back once they change it.
		const literals = inboundRawRetentionDaysValidator.members.map((m) => m.value);
		expect(literals).toContain(DEFAULT_INBOUND_RAW_RETENTION_DAYS);
	});
});
