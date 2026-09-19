/**
 * Inbound-mail file retention — the two sweeps that release BYTES and keep ROWS.
 *
 * Proven here:
 *   · the horizon is the one an admin CONFIGURED, not a constant: a 30-day
 *     setting releases a 45-day-old message and spares a 15-day-old one;
 *   · with nothing configured the shared 90-day default applies;
 *   · a released message keeps everything that is not the blob — messageId,
 *     subject, bodies, attachment metadata and its malware verdict;
 *   · a released attachment keeps its summary, extracted text and embedding, so
 *     `[RELEVANT FILES]` retrieval survives the sweep;
 *   · a file from a different source of the same age is untouched;
 *   · the sweeps are bounded per tick and resume, and a second pass over the
 *     same data releases nothing further.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	DEFAULT_INBOUND_RAW_RETENTION_DAYS,
	INBOUND_RAW_RETENTION_DAY_CHOICES,
} from '@owlat/shared/inboundRetention';
import { inboundRawRetentionDaysValidator } from '../../lib/convexValidators';

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

async function setHorizon(t: ReturnType<typeof convexTest>, days: number): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			inboundRawRetentionDays: days as 30 | 90 | 180 | 365,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/** Insert an inbound message holding a raw blob, received `ageDays` ago. */
async function seedInboundMessage(
	t: ReturnType<typeof convexTest>,
	messageId: string,
	now: number,
	ageDays: number
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
			receivedAt: now - ageDays * DAY_MS,
			rawStorageId: storageId,
			rawSize: 42,
			rawRetained: true,
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
	sourceType: 'email_attachment' | 'upload'
): Promise<Id<'semanticFiles'>> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([`bytes of ${filename}`]));
		return await ctx.db.insert('semanticFiles', {
			storageId,
			filename,
			mimeType: 'text/plain',
			fileSize: 12,
			sourceType,
			summary: 'a summary that outlives the bytes',
			extractedText: 'extracted text that outlives the bytes',
			embedding: Array.from({ length: 1536 }, () => 0.1),
			version: 1,
			createdAt: now - ageDays * DAY_MS,
			updatedAt: now - ageDays * DAY_MS,
		});
	});
}

describe('sweepInboundRawBlobs', () => {
	it('honours the configured horizon rather than a constant', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		const stale = await seedInboundMessage(t, '<stale@example.com>', now, 45);
		const fresh = await seedInboundMessage(t, '<fresh@example.com>', now, 15);
		const staleBlob = await t.run(async (ctx) => (await ctx.db.get(stale))!.rawStorageId!);

		await t.mutation(internal.maintenance.retention.sweepInboundRawBlobs, { now });

		const staleRow = await t.run(async (ctx) => await ctx.db.get(stale));
		// The BLOB is gone.
		expect(staleRow!.rawStorageId).toBeUndefined();
		expect(staleRow!.rawSize).toBeUndefined();
		expect(staleRow!.rawRetained).toBeUndefined();
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
		expect(freshRow!.rawRetained).toBe(true);
	});

	it('falls back to the shared default when nothing is configured', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		expect(DEFAULT_INBOUND_RAW_RETENTION_DAYS).toBe(90);
		const inside = await seedInboundMessage(t, '<inside@example.com>', now, 45);
		const outside = await seedInboundMessage(t, '<outside@example.com>', now, 120);

		await t.mutation(internal.maintenance.retention.sweepInboundRawBlobs, { now });

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

		await t.mutation(internal.maintenance.retention.sweepInboundRawBlobs, { now });
		// One tick cannot have finished: the batch came back full.
		const afterFirst = await t.run(async (ctx) =>
			(await ctx.db.query('inboundMessages').collect()).filter((r) => r.rawRetained === true)
		);
		expect(afterFirst).toHaveLength(BATCH + 2 - BATCH);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();

		const retained = await t.run(async (ctx) =>
			(await ctx.db.query('inboundMessages').collect()).filter((r) => r.rawRetained === true)
		);
		// Only the row inside the horizon still holds bytes.
		expect(retained).toHaveLength(1);
		expect(retained[0]!._id).toBe(fresh);
	});
});

describe('sweepInboundAttachmentBlobs', () => {
	it('releases an aged email attachment while keeping what retrieval needs', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		const stale = await seedSemanticFile(t, 'stale.txt', now, 45, 'email_attachment');
		const staleBlob = await t.run(async (ctx) => (await ctx.db.get(stale))!.storageId!);

		await t.mutation(internal.maintenance.retention.sweepInboundAttachmentBlobs, { now });

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

		await t.mutation(internal.maintenance.retention.sweepInboundAttachmentBlobs, { now });

		const row = await t.run(async (ctx) => await ctx.db.get(upload));
		// A file a user uploaded is theirs; this sweep is about mail we received.
		expect(row!.storageId).toBeDefined();
		expect(row!.bytesReleasedAt).toBeUndefined();
	});

	it('releases nothing further on a second pass over the same data', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await setHorizon(t, 30);
		const stale = await seedSemanticFile(t, 'stale.txt', now, 45, 'email_attachment');

		await t.mutation(internal.maintenance.retention.sweepInboundAttachmentBlobs, { now });
		const firstPass = (await t.run(async (ctx) => await ctx.db.get(stale)))!.bytesReleasedAt;

		// A second run a day later must not re-stamp the row: an already-released
		// row falls out of the index range, which is what terminates the walk.
		await t.mutation(internal.maintenance.retention.sweepInboundAttachmentBlobs, {
			now: now + DAY_MS,
		});
		const secondPass = (await t.run(async (ctx) => await ctx.db.get(stale)))!.bytesReleasedAt;
		expect(secondPass).toBe(firstPass);
	});
});

describe('the retention horizon choices', () => {
	it('offers exactly the day counts the validator accepts', () => {
		// Convex validators must be literal, so the set is spelled out in
		// convexValidators.ts. This is what keeps it in step with the shared
		// constant the admin form renders from.
		const literals = inboundRawRetentionDaysValidator.members.map((m) => m.value);
		expect([...literals].sort((a, b) => a - b)).toEqual(
			[...INBOUND_RAW_RETENTION_DAY_CHOICES].sort((a, b) => a - b)
		);
		// And the default is one of them — an unreachable default is a setting
		// nobody can put back.
		expect(literals).toContain(DEFAULT_INBOUND_RAW_RETENTION_DAYS);
	});
});
