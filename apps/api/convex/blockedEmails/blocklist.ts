/**
 * The suppression list: the operator's reads and manual blocks. Provider-sourced
 * suppressions are written by `events.ts`.
 */
import { v, type ObjectType } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import {
	hasPermission,
	requirePermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import {
	isValidEmail,
	normalizeEmail,
	validateStringLength,
	STRING_LIMITS,
} from '../lib/inputGuards';
import { getOrThrow, throwInvalidInput, throwAlreadyExists } from '../_utils/errors';
import * as sm from '../delivery/suppressionMirrorScheduler';
import { recordAuditLog } from '../lib/auditLog';
import { restoreSunsetSuppression } from '../contacts/sunsetRestore';
import { findLiveContactByEmail } from '../lib/contactHelpers';
import {
	blockedEmailReasonValidator,
	manualOrEventBlockReasonValidator,
} from '../lib/literalValidators';
import { deriveBlockSourceType } from './events';
import { BLOCKLIST_VIEW_LIMIT, countBlockedByReason, findBlockedByEmail } from './lookup';

/** `listByTeam`'s arguments. */
export const listByTeamArgs = {
	// Every stored reason is filterable, the sunset engine's `unengaged`
	// included: an operator has to be able to separate "we stopped mailing
	// this address because it never engaged" from a bounce, a complaint, or
	// a human decision.
	reason: v.optional(blockedEmailReasonValidator),
};

// List the most recent blocked emails (most-recent-first) with optional reason filter.
// all-members: the suppression list every member may read before sending (the
// audience Suppressions page). The provider audit evidence behind a row stays
// admin-only in `listProviderProvenance`.
export const listByTeam = authedQuery({
	args: listByTeamArgs,
	handler: async (ctx, args) => await listBlockedEmails(ctx, args),
});

/** The body of `listByTeam`. */
export async function listBlockedEmails(ctx: QueryCtx, args: ObjectType<typeof listByTeamArgs>) {
	const reason = args.reason;
	if (reason) {
		return await ctx.db
			.query('blockedEmails')
			.withIndex('by_reason', (q) => q.eq('reason', reason))
			.order('desc')
			.take(BLOCKLIST_VIEW_LIMIT);
	}
	return await ctx.db.query('blockedEmails').order('desc').take(BLOCKLIST_VIEW_LIMIT);
}

/**
 * WHO PUT THIS HERE — provenance for the provider-driven suppressions on the
 * blocklist screen.
 *
 * A `manual`-reason row means either "a human typed this address in" or, from
 * the Mandrill reject sync, "the provider's own blacklist rejected it and we
 * mirrored that", with no operator behind it at all. Those two are
 * indistinguishable on the row itself, and deliberately so: the suppression
 * schema has no provenance column because provenance is an EVENT, not a
 * property of the address — re-blocking an address that was already blocked
 * writes nothing, so a column would record only whichever cause happened to
 * arrive first.
 *
 * The event lives where events live: the `blocklist.provider_suppressed` audit
 * entry, keyed by the blocklist row's own id (`resourceId`). This read joins the
 * two so the screen can answer the question without a schema change and without
 * an N+1 lookup per row.
 *
 * Admin-gated: audit data is not a member-level read (the same reason
 * `auditActions/logs.list` is gated), and the evidence string is a third party's raw
 * reason code. Not org-keyed, exactly like the `blockedEmails` rows it explains:
 * both are deployment-wide under the singleton-org invariant, and the writer
 * (`addFromEvent`, a system actor with no session) has no organization to
 * attribute the entry to.
 */
// authz: listProviderEvidence requires organization:manage before it reads.
export const listProviderProvenance = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => await listProviderEvidence(ctx, session),
});

/** The body of `listProviderProvenance`. */
export async function listProviderEvidence(ctx: QueryCtx, session: MutationSessionContext) {
	requirePermission(hasPermission(session.role, 'organization:manage'));
	const entries = await ctx.db
		.query('auditLogs')
		.withIndex('by_action', (q) => q.eq('action', 'blocklist.provider_suppressed'))
		.order('desc')
		.take(BLOCKLIST_VIEW_LIMIT);

	return entries.flatMap((entry) => {
		const details = entry.details;
		if (!entry.resourceId || !details) return [];
		const provider = details['provider'];
		const source = details['source'];
		if (typeof provider !== 'string' || typeof source !== 'string') return [];
		const evidence = details['evidence'];
		return [
			{
				blockedEmailId: entry.resourceId,
				provider,
				source,
				evidence: typeof evidence === 'string' ? evidence : null,
				recordedAt: entry.createdAt,
			},
		];
	});
}

/** `getByEmail`'s arguments. */
export const getByEmailArgs = { email: v.string() };

// Get blocked email record by email (returns the record or null)
// all-members: the suppression state the contact detail page shows every member.
export const getByEmail = authedQuery({
	args: getByEmailArgs,
	handler: async (ctx, args) => await findBlockedByEmail(ctx, args.email),
});

/** `add`'s arguments. */
export const addBlockedEmailArgs = {
	email: v.string(),
	reason: manualOrEventBlockReasonValidator,
	notes: v.optional(v.string()),
	sourceEmailSendId: v.optional(v.id('emailSends')),
	sourceTransactionalSendId: v.optional(v.id('transactionalSends')),
};

// Add an email to the blocklist (manual block)
// authz: addBlockedEmail requires contacts:manage before it writes.
export const add = authedMutation({
	args: addBlockedEmailArgs,
	handler: async (ctx, args, session) => await addBlockedEmail(ctx, args, session),
});

/** The body of `add`. */
export async function addBlockedEmail(
	ctx: MutationCtx,
	args: ObjectType<typeof addBlockedEmailArgs>,
	session: MutationSessionContext
): Promise<Id<'blockedEmails'>> {
	validateStringLength(args.email, STRING_LIMITS.EMAIL, 'email');
	if (args.notes !== undefined)
		validateStringLength(args.notes, STRING_LIMITS.DESCRIPTION, 'notes');

	requirePermission(
		hasPermission(session.role, 'contacts:manage'),
		'Only owners and admins can manage the blocklist'
	);
	const normalizedEmail = normalizeEmail(args.email);

	// Validate email format
	if (!isValidEmail(normalizedEmail)) {
		throwInvalidInput('Invalid email address format');
	}

	// Check if already blocked
	const existing = await findBlockedByEmail(ctx, normalizedEmail);

	if (existing) {
		throwAlreadyExists('This email address is already blocked');
	}

	// Create the blocked email record
	const sourceType = deriveBlockSourceType(args);
	const blockedEmailId = await ctx.db.insert('blockedEmails', {
		email: normalizedEmail,
		reason: args.reason,
		notes: args.notes,
		sourceType,
		sourceEmailSendId: args.sourceEmailSendId,
		sourceTransactionalSendId: args.sourceTransactionalSendId,
		createdAt: Date.now(),
	});

	await recordAuditLog(ctx, {
		userId: session.userId,
		action: 'blocklist.added',
		resource: 'blocklist',
		resourceId: blockedEmailId,
		details: { email: normalizedEmail, reason: args.reason },
	});

	// Mirror to the MTA's Redis suppression backstop (manual UI blocks never
	// reach it otherwise). Fire-and-forget; never rolls back the insert.
	await sm.scheduleSuppressionMirror(ctx, {
		email: normalizedEmail,
		reason: args.reason,
	});

	return blockedEmailId;
}

/** `remove`'s arguments. */
export const removeBlockedEmailArgs = { blockedEmailId: v.id('blockedEmails') };

// Remove an email from the blocklist
// authz: removeBlockedEmail requires contacts:manage before it reads or writes.
export const remove = authedMutation({
	args: removeBlockedEmailArgs,
	handler: async (ctx, args, session) =>
		await removeBlockedEmail(ctx, args.blockedEmailId, session),
});

/** The body of `remove`. */
export async function removeBlockedEmail(
	ctx: MutationCtx,
	blockedEmailId: Id<'blockedEmails'>,
	session: MutationSessionContext
): Promise<{ success: boolean }> {
	requirePermission(
		hasPermission(session.role, 'contacts:manage'),
		'Only owners and admins can manage the blocklist'
	);
	const blockedEmail = await getOrThrow(ctx, blockedEmailId, 'Blocked email');

	// A SUNSET SUPPRESSION IS UNDONE BY THE SUNSET RESTORE PATH, NOT BY A
	// DELETE. Deleting the row alone leaves the contact's stage and quiet
	// window exactly as the engine found them, so the next sweep re-suppresses
	// it within the day with a fresh audit entry and no explanation — the
	// visible "Remove" action would undo itself. Routing through
	// `restoreSunsetSuppression` deletes the same row AND sets the operator
	// override that stops the engine touching the contact again, and it emits
	// its own `contact.sunset_restored` audit entry.
	if (blockedEmail.reason === 'unengaged') {
		// `by_email` is NOT unique and `contacts` is a soft-delete table, so the
		// lookup must skip soft-deleted rows (CONVENTIONS.md): a soft-deleted
		// duplicate sorting first would otherwise send the operator down the
		// plain delete below, leaving the live contact pinned at
		// `sunsetStage: 'suppressed'` with no blocklist row behind it and the
		// engine holding on `already_suppressed` forever.
		const contact = await findLiveContactByEmail(ctx, blockedEmail.email);
		if (contact !== null) {
			const restore = await restoreSunsetSuppression(ctx, {
				contactId: contact._id,
				actorUserId: session.userId,
				now: Date.now(),
			});
			if (restore.outcome === 'restored') return { success: true };
		}
		// No live contact row behind the address (imported, merged away,
		// hard-deleted): there is no stage to reset, so the plain delete below
		// is the whole job.
	}

	await ctx.db.delete(blockedEmailId);

	await recordAuditLog(ctx, {
		userId: session.userId,
		action: 'blocklist.removed',
		resource: 'blocklist',
		resourceId: blockedEmailId,
		details: { email: blockedEmail.email, reason: blockedEmail.reason },
	});

	await sm.scheduleSuppressionUnmirror(ctx, blockedEmail.email, blockedEmail.reason);
	return { success: true };
}

// Hard cap on one bulkAdd request. The manual-block import path is an operator
// tool, not a bulk ingest firehose; bounding the array keeps a single mutation's
// insert + mirror + audit fan-out inside Convex's per-transaction write budget.
export const MAX_BULK_BLOCK_ADD = 1000;

/** `bulkAdd`'s arguments. */
export const bulkAddArgs = {
	emails: v.array(
		v.object({
			email: v.string(),
			reason: manualOrEventBlockReasonValidator,
			notes: v.optional(v.string()),
		})
	),
};

// Bulk add emails to the blocklist (for import or auto-blocking)
// authz: bulkAddBlockedEmails requires contacts:manage before it writes.
export const bulkAdd = authedMutation({
	args: bulkAddArgs,
	handler: async (ctx, args, session) => await bulkAddBlockedEmails(ctx, args, session),
});

/** The body of `bulkAdd`. */
export async function bulkAddBlockedEmails(
	ctx: MutationCtx,
	args: ObjectType<typeof bulkAddArgs>,
	session: MutationSessionContext
): Promise<{ added: number; skipped: number; errors: string[] }> {
	requirePermission(
		hasPermission(session.role, 'contacts:manage'),
		'Only owners and admins can manage the blocklist'
	);

	// Bound the request before any write.
	if (args.emails.length > MAX_BULK_BLOCK_ADD) {
		throwInvalidInput(`Cannot block more than ${MAX_BULK_BLOCK_ADD} addresses at once`);
	}

	for (const item of args.emails) {
		validateStringLength(item.email, STRING_LIMITS.EMAIL, 'email');
		if (item.notes !== undefined)
			validateStringLength(item.notes, STRING_LIMITS.DESCRIPTION, 'notes');
	}

	const results = { added: 0, skipped: 0, errors: [] as string[] };

	for (const item of args.emails) {
		const normalizedEmail = normalizeEmail(item.email);

		// Validate email format
		if (!isValidEmail(normalizedEmail)) {
			results.errors.push(`Invalid email format: ${item.email}`);
			results.skipped++;
			continue;
		}

		// Check if already blocked
		const existing = await findBlockedByEmail(ctx, normalizedEmail);

		if (existing) {
			results.skipped++;
			continue;
		}

		// Add to blocklist
		const blockedEmailId = await ctx.db.insert('blockedEmails', {
			email: normalizedEmail,
			reason: item.reason,
			notes: item.notes,
			createdAt: Date.now(),
		});

		// Audit each address a bulk block added — the single `add` path logs
		// `blocklist.added`, and a bulk block must leave the same trail so a
		// mass suppression is attributable to the operator who ran it.
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'blocklist.added',
			resource: 'blocklist',
			resourceId: blockedEmailId,
			details: { email: normalizedEmail, reason: item.reason, bulk: true },
		});

		// Mirror to the MTA's Redis suppression backstop. Fire-and-forget.
		await sm.scheduleSuppressionMirror(ctx, {
			email: normalizedEmail,
			reason: item.reason,
		});

		results.added++;
	}

	return results;
}

// Get count of blocked emails by reason. Each count saturates at
// BLOCKLIST_VIEW_LIMIT, matching the capped list view (see countBlockedByReason).
// all-members: per-reason counts behind the member-readable suppression list.
export const getCountsByReason = authedQuery({
	args: {},
	handler: async (ctx) => await countBlockedByReason(ctx),
});
