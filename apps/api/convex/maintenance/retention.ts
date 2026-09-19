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
 *     attachment blobs captured out of it into `semanticFiles` are released
 *     after an ADMIN-CONFIGURABLE horizon (default 90 days). These two sweeps
 *     release BYTES ONLY — every row and all of its metadata is retained.
 *
 * All sweeps are batched and self-rescheduling, following
 * webhooks/cleanup.cleanupOldLogs.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { AUDIT_LOG_RETENTION_MS } from '../lib/constants';
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
// These two sweeps are the bound. They delete BLOBS and keep ROWS: after a
// sweep the message still lists, still reads, still shows what was attached and
// still carries its authentication and malware verdicts; a released
// `semanticFiles` row still carries its summary, extracted text and embedding,
// so `[RELEVANT FILES]` retrieval is unaffected. What is gone is the download.

/** ms in a day, for turning the configured horizon into a cutoff. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The configured horizon as a cutoff timestamp. Unset ⇒ the shared default. */
async function inboundRetentionCutoff(
	ctx: { db: { query: (table: 'instanceSettings') => { first: () => Promise<unknown> } } },
	now: number
): Promise<number> {
	const settings = (await ctx.db.query('instanceSettings').first()) as {
		inboundRawRetentionDays?: number;
	} | null;
	const days = settings?.inboundRawRetentionDays ?? DEFAULT_INBOUND_RAW_RETENTION_DAYS;
	return now - days * DAY_MS;
}

/**
 * Release the sealed raw `.eml` of inbound messages past the horizon.
 *
 * Indexed on `rawRetained` rather than walked by time: almost every row in this
 * table predates raw storage and holds no blob at all, so a time-only walk
 * would re-scan the whole history on every tick and never terminate. The
 * marker keeps the scanned range to rows that still hold bytes, and clearing it
 * is what takes a swept row out of that range for good.
 */
export const sweepInboundRawBlobs = internalMutation({
	// `now` is injectable so the horizon is testable without waiting for it.
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const cutoff = await inboundRetentionCutoff(ctx, args.now ?? Date.now());
		const stale = await ctx.db
			.query('inboundMessages')
			.withIndex('by_raw_retention', (q) =>
				q.eq('rawRetained', true).lt('receivedAt', cutoff)
			)
			.take(BATCH);
		for (const row of stale) {
			if (row.rawStorageId) {
				try {
					await ctx.storage.delete(row.rawStorageId);
				} catch {
					// Already gone (a prior partial sweep, a manual purge). The patch
					// below still has to run or the row stays in the scanned range.
				}
			}
			await ctx.db.patch(row._id, {
				rawStorageId: undefined,
				rawSize: undefined,
				rawRetained: undefined,
			});
		}
		if (stale.length === BATCH) {
			await ctx.scheduler.runAfter(0, internal.maintenance.retention.sweepInboundRawBlobs, args);
		}
	},
});

/**
 * Release the blobs of attachments captured out of inbound mail, past the same
 * horizon and from the same setting.
 *
 * `bytesReleasedAt` is both the record and the terminator: an already-released
 * row no longer matches the index range, so a second pass over the same data
 * releases nothing further.
 */
export const sweepInboundAttachmentBlobs = internalMutation({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();
		const cutoff = await inboundRetentionCutoff(ctx, now);
		const stale = await ctx.db
			.query('semanticFiles')
			.withIndex('by_attachment_retention', (q) =>
				q
					.eq('sourceType', 'email_attachment')
					.eq('bytesReleasedAt', undefined)
					.lt('createdAt', cutoff)
			)
			.take(BATCH);
		for (const row of stale) {
			if (row.storageId) {
				try {
					await ctx.storage.delete(row.storageId);
				} catch {
					// Already gone — record the release anyway.
				}
			}
			// The row, its summary, its extracted text and its embedding all stay.
			await ctx.db.patch(row._id, { storageId: undefined, bytesReleasedAt: now });
		}
		if (stale.length === BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.maintenance.retention.sweepInboundAttachmentBlobs,
				args
			);
		}
	},
});
