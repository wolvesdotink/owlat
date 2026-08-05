import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery } from './_generated/server';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { isValidEmail, normalizeEmail } from './lib/inputGuards';
import { getOrThrow, throwInvalidInput, throwAlreadyExists } from './_utils/errors';
import { scheduleSuppressionMirror } from './delivery/suppressionMirror';
import { recordAuditLog } from './lib/auditLog';
import { restoreSunsetSuppression } from './contacts/sunsetRestore';

// Look up a blocklist row by email. Normalizes (lowercase + trim) so every
// caller hits the `by_email` index with the same key, then returns the first
// match or null. Single source of truth for the blocklist-by-email read.
async function findBlockedByEmail(
	ctx: QueryCtx | MutationCtx,
	email: string
): Promise<Doc<'blockedEmails'> | null> {
	const normalizedEmail = normalizeEmail(email);
	return await ctx.db
		.query('blockedEmails')
		.withIndex('by_email', (q) => q.eq('email', normalizedEmail))
		.first();
}

// Derive the polymorphic block `sourceType` from whichever source-send id was
// supplied (emailSend vs transactionalSend), or undefined for a manual block.
function deriveBlockSourceType(source: {
	sourceEmailSendId?: Id<'emailSends'>;
	sourceTransactionalSendId?: Id<'transactionalSends'>;
}): 'emailSend' | 'transactionalSend' | undefined {
	return source.sourceEmailSendId
		? 'emailSend'
		: source.sourceTransactionalSendId
			? 'transactionalSend'
			: undefined;
}

// Hard cap on the blocklist view. blockedEmails grows unboundedly with bounces
// and complaints, and an unbounded `.collect()` would eventually trip Convex's
// per-query document read limit. Return the most recent N (ordered by creation
// time via the implicit by_creation_time index / the by_reason index) instead
// of every row; the UI filters by reason for anything older.
//
// Exported because it is the cap every count of this table saturates at — the
// operator counter below and the platform-admin org detail
// (`platformAdmin/queries.ts`) must not disagree about the same number.
export const BLOCKLIST_VIEW_LIMIT = 1000;

// List the most recent blocked emails (most-recent-first) with optional reason filter.
export const listByTeam = authedQuery({
	args: {
		reason: v.optional(
			v.union(
				v.literal('bounced'),
				v.literal('complained'),
				v.literal('manual'),
				// The sunset engine's own reason (P4-4). Filterable like the rest:
				// an operator looking at the blocklist has to be able to separate
				// "we stopped mailing this address because it never engaged" from a
				// bounce, a complaint, or a human decision.
				v.literal('unengaged')
			)
		),
	},
	handler: async (ctx, args) => {
		const reason = args.reason;
		if (reason) {
			return await ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', reason))
				.order('desc')
				.take(BLOCKLIST_VIEW_LIMIT);
		}
		return await ctx.db.query('blockedEmails').order('desc').take(BLOCKLIST_VIEW_LIMIT);
	},
});

// Get a single blocked email by ID
export const get = authedQuery({
	args: { blockedEmailId: v.id('blockedEmails') },
	handler: async (ctx, args) => {
		const blockedEmail = await ctx.db.get(args.blockedEmailId);
		if (!blockedEmail) return null;
		return blockedEmail;
	},
});

// Check if an email is blocked
export const isBlocked = authedQuery({
	args: {
		email: v.string(),
	},
	handler: async (ctx, args) => {
		return (await findBlockedByEmail(ctx, args.email)) !== null;
	},
});

// Get blocked email record by email (returns the record or null)
export const getByEmail = authedQuery({
	args: {
		email: v.string(),
	},
	handler: async (ctx, args) => {
		return await findBlockedByEmail(ctx, args.email);
	},
});

// Add an email to the blocklist (manual block)
export const add = authedMutation({
	args: {
		email: v.string(),
		reason: v.union(v.literal('bounced'), v.literal('complained'), v.literal('manual')),
		notes: v.optional(v.string()),
		sourceEmailSendId: v.optional(v.id('emailSends')),
		sourceTransactionalSendId: v.optional(v.id('transactionalSends')),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'contacts:manage',
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
		await scheduleSuppressionMirror(ctx, {
			email: normalizedEmail,
			reason: args.reason,
		});

		return blockedEmailId;
	},
});

// Remove an email from the blocklist
export const remove = authedMutation({
	args: { blockedEmailId: v.id('blockedEmails') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can manage the blocklist'
		);
		const blockedEmail = await getOrThrow(ctx, args.blockedEmailId, 'Blocked email');

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
			// live-row filter belongs IN the query (CONVENTIONS.md): a soft-deleted
			// duplicate sorting first would otherwise send the operator down the
			// plain delete below, leaving the live contact pinned at
			// `sunsetStage: 'suppressed'` with no blocklist row behind it and the
			// engine holding on `already_suppressed` forever.
			const contact = await ctx.db
				.query('contacts')
				.withIndex('by_email', (q) => q.eq('email', blockedEmail.email))
				.filter((q) => q.eq(q.field('deletedAt'), undefined))
				.first();
			if (contact !== null) {
				const restore = await restoreSunsetSuppression(ctx, {
					contactId: contact._id,
					actorUserId: session.userId,
					now: Date.now(),
				});
				// The restore removed the row and reset the stage — nothing left to do.
				if (restore.outcome === 'restored') return { success: true };
			}
			// No live contact row behind the address (imported, merged away,
			// hard-deleted): there is no stage to reset, so the plain delete below
			// is the whole job.
		}

		await ctx.db.delete(args.blockedEmailId);

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'blocklist.removed',
			resource: 'blocklist',
			resourceId: args.blockedEmailId,
			details: { email: blockedEmail.email, reason: blockedEmail.reason },
		});

		return { success: true };
	},
});

// Bulk add emails to the blocklist (for import or auto-blocking)
export const bulkAdd = authedMutation({
	args: {
		emails: v.array(
			v.object({
				email: v.string(),
				reason: v.union(v.literal('bounced'), v.literal('complained'), v.literal('manual')),
				notes: v.optional(v.string()),
			})
		),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can manage the blocklist'
		);
		const results = {
			added: 0,
			skipped: 0,
			errors: [] as string[],
		};

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
			await ctx.db.insert('blockedEmails', {
				email: normalizedEmail,
				reason: item.reason,
				notes: item.notes,
				createdAt: Date.now(),
			});

			// Mirror to the MTA's Redis suppression backstop. Fire-and-forget.
			await scheduleSuppressionMirror(ctx, {
				email: normalizedEmail,
				reason: item.reason,
			});

			results.added++;
		}

		return results;
	},
});

// Get count of blocked emails by reason
export const getCountsByReason = authedQuery({
	args: {},
	handler: async (ctx) => {
		// Capped per reason (matching listByTeam's BLOCKLIST_VIEW_LIMIT): blockedEmails
		// is append-only with no expiry, so bounced/complained reach tens of
		// thousands and three uncapped collects would trip the per-query read limit
		// before the (already-capped) list view does. Counts saturate at the cap.
		const [bounced, complained, manual, unengaged] = await Promise.all([
			ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', 'bounced'))
				.take(BLOCKLIST_VIEW_LIMIT),
			ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', 'complained'))
				.take(BLOCKLIST_VIEW_LIMIT),
			ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', 'manual'))
				.take(BLOCKLIST_VIEW_LIMIT),
			ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', 'unengaged'))
				.take(BLOCKLIST_VIEW_LIMIT),
		]);

		return {
			total: bounced.length + complained.length + manual.length + unengaged.length,
			bounced: bounced.length,
			complained: complained.length,
			manual: manual.length,
			unengaged: unengaged.length,
		};
	},
});

// Internal query to check if an email is blocked (for use by other Convex functions)
// Unlike the public `isBlocked` query, this does not require access validation
export const isBlockedInternal = internalQuery({
	args: {
		email: v.string(),
	},
	handler: async (ctx, args) => {
		return (await findBlockedByEmail(ctx, args.email)) !== null;
	},
});

// Internal function to add to blocklist from bounce/complaint handler
// This is exported for use by other Convex functions
//
// THE ONE WRITER FOR PROVIDER-SOURCED SUPPRESSIONS. Two callers share it today
// — the redacted-complaint path (`webhooks/complaintDispatch.ts`) and the
// Mandrill reject sync (`webhooks/mandrillRejectSuppression.ts`, plan D9) — and
// the suppression IMPORT that carries a migrating deployment's accumulated
// Mandrill/Mailchimp list over is meant to be the third, so that "already
// blocked ⇒ no second row, no second mirror, no second audit entry" is decided
// once rather than once per ingress.
//
// Three additive widenings serve that (plan D9), all optional so every shipped
// caller is untouched:
//   - `reason` accepts `'manual'`, the class an operator-curated blacklist
//     entry belongs to (Mandrill `custom` / `rule`). The schema union has
//     always had it; only this validator was narrower.
//   - `bounceType` is carried through to the row AND to the MTA mirror, where
//     it decides permanent (`hard_bounce`) vs. expiring (`manual`) backstop
//     entries — a soft-bounce suppression that mirrored as hard would be
//     unrecoverable at the last hop.
//   - `provenance` names WHO caused the suppression, and its presence is what
//     turns on the audit entry. The lifecycle-effect callers have a Send row to
//     explain themselves with; a provider blacklist hit or a bulk import has
//     nothing on the suppression screen to say where the address came from.
export const addFromEvent = internalMutation({
	args: {
		email: v.string(),
		reason: v.union(v.literal('bounced'), v.literal('complained'), v.literal('manual')),
		bounceType: v.optional(v.union(v.literal('hard'), v.literal('soft'))),
		sourceEmailSendId: v.optional(v.id('emailSends')),
		sourceTransactionalSendId: v.optional(v.id('transactionalSends')),
		provenance: v.optional(
			v.object({
				/** Send-provider kind the suppression came from, e.g. `mandrill`. */
				provider: v.string(),
				/** Ongoing feedback vs. a one-off carry-over of an existing list. */
				source: v.union(v.literal('webhook'), v.literal('import')),
				/** The provider's own reason code, e.g. `MANDRILL_REJECT_SPAM`. */
				evidence: v.optional(v.string()),
			})
		),
	},
	handler: async (ctx, args) => {
		const normalizedEmail = normalizeEmail(args.email);

		// Check if already blocked - if so, don't add duplicate
		const existing = await findBlockedByEmail(ctx, normalizedEmail);

		if (existing) {
			// Already blocked, just return the existing ID. A replayed webhook batch
			// or a re-run import therefore writes NOTHING — no row, no mirror, and
			// (below) no audit entry, because an audit trail records state changes
			// and this call changed no state.
			return existing._id;
		}

		// Create the blocked email record
		const sourceType = deriveBlockSourceType(args);
		const blockedEmailId = await ctx.db.insert('blockedEmails', {
			email: normalizedEmail,
			reason: args.reason,
			...(args.bounceType ? { bounceType: args.bounceType } : {}),
			sourceType,
			sourceEmailSendId: args.sourceEmailSendId,
			sourceTransactionalSendId: args.sourceTransactionalSendId,
			createdAt: Date.now(),
		});

		if (args.provenance) {
			await recordAuditLog(ctx, {
				userId: `system:${args.provenance.provider}_${args.provenance.source}`,
				action: 'blocklist.provider_suppressed',
				resource: 'blocklist',
				resourceId: blockedEmailId,
				details: {
					email: normalizedEmail,
					reason: args.reason,
					provider: args.provenance.provider,
					source: args.provenance.source,
					...(args.bounceType ? { bounceType: args.bounceType } : {}),
					...(args.provenance.evidence ? { evidence: args.provenance.evidence } : {}),
				},
			});
		}

		// Mirror provider-webhook bounce/complaint suppressions to the MTA's
		// Redis backstop (Resend/SES events land here, never on the MTA list
		// otherwise). Fire-and-forget; never rolls back the insert.
		await scheduleSuppressionMirror(ctx, {
			email: normalizedEmail,
			reason: args.reason,
			...(args.bounceType ? { bounceType: args.bounceType } : {}),
		});

		return blockedEmailId;
	},
});
