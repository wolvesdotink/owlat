/**
 * PII retention sweeps — daily crons that age out operational data nobody
 * needs forever. Before this module, auditLogs (IP/UA/contact emails in
 * details), mailAuditLog (IP/UA per mailbox action), and formSubmissions'
 * submitter IP/UA were retained unbounded with no policy.
 *
 * Policy:
 *   - auditLogs + mailAuditLog rows: deleted after AUDIT_LOG_RETENTION_MS
 *     (30 days) — long enough for incident forensics, bounded for privacy.
 *   - formSubmissions: the submission itself belongs to the contact (and is
 *     erased with the contact); only the operational metadata (ipAddress,
 *     userAgent) is scrubbed after FORM_META_RETENTION_MS.
 *   - inbound mail FILES: the sealed raw `.eml` on `inboundMessages` and the
 *     team-inbox attachment blobs captured out of it into `semanticFiles` are
 *     released after an ADMIN-CONFIGURABLE horizon
 *     (`DEFAULT_INBOUND_RAW_RETENTION_DAYS` when unset). That sweep releases
 *     BYTES ONLY — every row and all of its metadata is retained.
 *
 * All sweeps are batched and self-rescheduling, following
 * webhooks/cleanup.cleanupOldLogs.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { AUDIT_LOG_RETENTION_MS, DAY_MS } from '../lib/constants';
import { logError } from '../lib/runtimeLog';
import { DEFAULT_INBOUND_RAW_RETENTION_DAYS } from '@owlat/shared/inboundRetention';

const BATCH = 200;

/** Operational metadata on form submissions ages out after 90 days. */
const FORM_META_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const sweepAuditLogs = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - AUDIT_LOG_RETENTION_MS;
		const stale = await ctx.db
			.query('auditLogs')
			.withIndex('by_created_at', (q) => q.lt('createdAt', cutoff))
			.take(BATCH);
		for (const row of stale) await ctx.db.delete(row._id);
		if (stale.length === BATCH) {
			await ctx.scheduler.runAfter(0, internal.maintenance.retention.sweepAuditLogs, {});
		}
	},
});

export const sweepMailAuditLog = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - AUDIT_LOG_RETENTION_MS;
		const stale = await ctx.db
			.query('mailAuditLog')
			.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
			.take(BATCH);
		for (const row of stale) await ctx.db.delete(row._id);
		if (stale.length === BATCH) {
			await ctx.scheduler.runAfter(0, internal.maintenance.retention.sweepMailAuditLog, {});
		}
	},
});

/** Plugin LLM reservations and daily aggregates age out with the audit window. */
export const sweepPluginLlmAccounting = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - AUDIT_LOG_RETENTION_MS;
		const [reservations, dailyUsage] = await Promise.all([
			ctx.db
				.query('pluginLlmReservations')
				.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
				.take(BATCH),
			ctx.db
				.query('pluginLlmDailyUsage')
				.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
				.take(BATCH),
		]);
		for (const row of [...reservations, ...dailyUsage]) {
			await ctx.db.delete(row._id);
		}
		if (reservations.length === BATCH || dailyUsage.length === BATCH) {
			await ctx.scheduler.runAfter(0, internal.maintenance.retention.sweepPluginLlmAccounting, {});
		}
	},
});

export const scrubFormSubmissionMeta = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const cutoff = Date.now() - FORM_META_RETENTION_MS;
		// Cursor-paginated walk (scrubbed rows would still match an index range
		// probe, so a plain take() would re-read the same head forever).
		const page = await ctx.db
			.query('formSubmissions')
			.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
			.paginate({ cursor: args.cursor ?? null, numItems: BATCH });
		for (const row of page.page) {
			if (row.ipAddress !== undefined || row.userAgent !== undefined) {
				await ctx.db.patch(row._id, { ipAddress: undefined, userAgent: undefined });
			}
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.maintenance.retention.scrubFormSubmissionMeta, {
				cursor: page.continueCursor,
			});
		}
	},
});

// ── Inbound mail files ──────────────────────────────────────────────────────
//
// The shared inbox stores the whole received message so its attachments are
// reachable — bytes that grow without bound on a route any sender can reach.
// This sweep is the bound. It deletes BLOBS and keeps ROWS: afterwards the
// message still lists, still reads, still shows what was attached and still
// carries its authentication and malware verdicts; a released `semanticFiles`
// row still carries its summary, extracted text and embedding, so
// `[RELEVANT FILES]` retrieval is unaffected. What is gone is the download.

/**
 * The configured horizon as a cutoff timestamp. Unset ⇒
 * `DEFAULT_INBOUND_RAW_RETENTION_DAYS`.
 *
 * Read ONCE per sweep and passed to both walks: reading it twice meant an admin
 * who changed the setting between the two reads got one tick where the raw
 * `.eml` and the attachments pulled out of it aged on different horizons.
 */
async function inboundRetentionCutoff(ctx: Pick<MutationCtx, 'db'>, now: number): Promise<number> {
	const settings = await ctx.db.query('instanceSettings').first();
	const days = settings?.inboundRawRetentionDays ?? DEFAULT_INBOUND_RAW_RETENTION_DAYS;
	return now - days * DAY_MS;
}

/**
 * Release the sealed raw `.eml` of inbound messages past the horizon.
 *
 * Indexed on `isRawRetained` rather than walked by time: almost every row in
 * this table predates raw storage and holds no blob at all, so a time-only walk
 * would re-scan the whole history on every tick and never terminate. The marker
 * keeps the scanned range to rows that still hold bytes, and clearing it is
 * what takes a swept row out of that range for good.
 *
 * `rawSize` is deliberately NOT cleared and `rawReleasedAt` is stamped: a row
 * that has been swept has to be distinguishable from one whose bytes were never
 * carried, or the reader tells a user a retention window expired on a message
 * that arrived an hour ago.
 *
 * Returns how many rows it released, so the caller can decide whether another
 * pass is due.
 */
async function releaseRawBlobs(ctx: MutationCtx, now: number, cutoff: number): Promise<number> {
	const stale = await ctx.db
		.query('inboundMessages')
		.withIndex('by_raw_retention', (q) => q.eq('isRawRetained', true).lt('receivedAt', cutoff))
		.take(BATCH);
	for (const row of stale) {
		if (row.rawStorageId) {
			try {
				await ctx.storage.delete(row.rawStorageId);
			} catch (err) {
				// Usually "already gone" (a prior partial sweep, a manual purge), but
				// a transient storage failure lands here too and would otherwise
				// orphan the blob forever with no trace. The patch below still has to
				// run either way, or the row stays in the scanned range.
				logError('[retention] inbound raw blob delete failed', { rowId: row._id, err });
			}
		}
		await ctx.db.patch(row._id, {
			rawStorageId: undefined,
			isRawRetained: undefined,
			rawReleasedAt: now,
		});
	}
	return stale.length;
}

/**
 * Release the blobs of attachments captured out of TEAM-INBOX mail, past the
 * same horizon and from the same setting.
 *
 * Scoped by `captureSource`, not by `sourceType`: both inbound routes write
 * `sourceType: 'email_attachment'`, so filtering on that alone silently stripped
 * the file-library blobs of personal-mailbox (Postbox) deliveries too — mail
 * that keeps its own raw `.eml` permanently and has no horizon at all — under a
 * setting whose copy says "shared inbox".
 *
 * `bytesReleasedAt` is both the record and the terminator: an already-released
 * row no longer matches the index range, so a second pass releases nothing
 * further.
 */
async function releaseAttachmentBlobs(
	ctx: MutationCtx,
	now: number,
	cutoff: number
): Promise<number> {
	const stale = await ctx.db
		.query('semanticFiles')
		.withIndex('by_attachment_retention', (q) =>
			q.eq('captureSource', 'team_inbox').eq('bytesReleasedAt', undefined).lt('createdAt', cutoff)
		)
		.take(BATCH);
	for (const row of stale) {
		if (row.storageId) {
			try {
				await ctx.storage.delete(row.storageId);
			} catch (err) {
				logError('[retention] inbound attachment blob delete failed', { rowId: row._id, err });
			}
		}
		// The row, its summary, its extracted text and its embedding all stay.
		await ctx.db.patch(row._id, { storageId: undefined, bytesReleasedAt: now });
	}
	return stale.length;
}

/**
 * ONE sweep for one horizon. The raw `.eml` and the attachments pulled out of
 * it are the same decision measured from the same setting, so they are the same
 * mutation and the same cron entry — two of each meant a change to horizon
 * semantics had to be made in four places and be right in all of them.
 *
 * Self-rescheduling while EITHER walk filled its batch, so a backlog drains
 * without one side starving the other.
 */
export const sweepInboundFiles = internalMutation({
	// `now` is injectable so the horizon is testable without waiting for it.
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();
		// ONE horizon for one sweep, read once — see `inboundRetentionCutoff`.
		const cutoff = await inboundRetentionCutoff(ctx, now);
		const releasedRaw = await releaseRawBlobs(ctx, now, cutoff);
		const releasedAttachments = await releaseAttachmentBlobs(ctx, now, cutoff);
		if (releasedRaw === BATCH || releasedAttachments === BATCH) {
			await ctx.scheduler.runAfter(0, internal.maintenance.retention.sweepInboundFiles, args);
		}
		return { releasedRaw, releasedAttachments };
	},
});
