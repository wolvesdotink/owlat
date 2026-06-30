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
 *
 * All sweeps are batched and self-rescheduling, following
 * webhooks/cleanup.cleanupOldLogs.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { AUDIT_LOG_RETENTION_MS } from '../lib/constants';

const BATCH = 200;

/** Operational metadata on form submissions ages out after 90 days. */
export const FORM_META_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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
