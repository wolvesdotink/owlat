/**
 * The sunset OPERATOR paths — restore and exemption (deliverability plan P4-4).
 *
 * Split out of `sunsetEngine.ts` because they are a different job with a
 * different actor: the engine decides and writes on a cron with
 * `userId: 'system'`, while everything here is a person taking a deliberate
 * action and being recorded as having taken it. Both halves write to the same
 * shipped tables through the same helpers; only the reason a write happens
 * differs, and that is exactly the seam.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { recordAuditLog } from '../lib/auditLog';
import { normalizeEmail } from '../lib/inputGuards';

export type SunsetRestoreResult = {
	restored: boolean;
	/** True when a `reason: 'unengaged'` blocklist row was removed. */
	removedSuppression: boolean;
	/**
	 * WHAT HAPPENED, not why. Named `outcome` rather than `reason` because
	 * `sunsetPolicy.ts` owns `SunsetReason` — the engine's decision vocabulary —
	 * and the two are different vocabularies for different questions.
	 */
	outcome:
		| 'restored'
		| 'not_found'
		| 'no_email'
		| 'not_sunset_suppressed'
		/**
		 * The contact was not on the blocklist at all. Reported distinctly rather
		 * than as a `restored`: with no row to remove, "restore" would silently
		 * have been a bare exemption toggle, and an operator told "restored" would
		 * reasonably believe a suppression had been lifted.
		 */
		| 'not_suppressed';
};

/**
 * THE RESTORE PATH — one operator action, fully audited.
 *
 * It removes the blocklist row ONLY when that row is the engine's own
 * `reason: 'unengaged'` suppression: a hard bounce or a spam complaint is
 * evidence the sunset engine did not produce and must not erase, so those are
 * left in place and reported back as `not_sunset_suppressed`.
 *
 * Restoring also sets the operator override (`sunsetExemptAt`). Without it the
 * very next sweep would see the same 270 quiet days and immediately re-suppress
 * the contact — "restore" that undoes itself within a day is not a restore.
 *
 * THE OVERRIDE IS PERMANENT AND VISIBLE, NOT PERMANENT AND HIDDEN. It has no
 * expiry on purpose: an operator who reached for "restore" is asserting they
 * know something the engine does not, and quietly re-arming auto-suppression
 * after some interval would take that assertion away without telling anyone. It
 * is instead SURFACED — `contacts.sunset.listSunsetStage` projects it as
 * `isExempt`, the suppressions screen renders it, and
 * `setSunsetContactExemption` clears it in one action — so "why is this contact
 * never sunset" is always answerable and always reversible.
 *
 * A contact with NO blocklist row is reported as `not_suppressed` and nothing is
 * written: restore restores, it does not double as an exemption toggle.
 */
export async function restoreSunsetSuppression(
	ctx: MutationCtx,
	args: { contactId: Id<'contacts'>; actorUserId: string; now: number }
): Promise<SunsetRestoreResult> {
	const contact = await ctx.db.get(args.contactId);
	if (!contact || contact.deletedAt !== undefined) {
		return { restored: false, removedSuppression: false, outcome: 'not_found' };
	}
	const email = contact.email;
	if (email === undefined || email.trim().length === 0) {
		return { restored: false, removedSuppression: false, outcome: 'no_email' };
	}

	const blocked = await ctx.db
		.query('blockedEmails')
		.withIndex('by_email', (q) => q.eq('email', normalizeEmail(email)))
		.first();

	if (blocked === null) {
		// NOT A RESTORE. There is nothing suppressed to bring back, so this call
		// does not quietly become `setSunsetExemption` — that is a separate,
		// explicit operator action with its own audit entry.
		return { restored: false, removedSuppression: false, outcome: 'not_suppressed' };
	}
	if (blocked.reason !== 'unengaged') {
		return { restored: false, removedSuppression: false, outcome: 'not_sunset_suppressed' };
	}

	await ctx.db.delete(blocked._id);

	await ctx.db.patch(contact._id, {
		sunsetStage: 'engaged',
		sunsetStageAt: args.now,
		sunsetEvaluatedAt: args.now,
		sunsetExemptAt: args.now,
	});

	await recordAuditLog(ctx, {
		userId: args.actorUserId,
		action: 'contact.sunset_restored',
		resource: 'contact',
		resourceId: contact._id,
		details: {
			email,
			removedSuppression: true,
			fromStage: contact.sunsetStage ?? 'engaged',
			exempted: true,
		},
	});

	return { restored: true, removedSuppression: true, outcome: 'restored' };
}

/** Toggle the operator override for one contact. Audited either way. */
export async function setSunsetExemption(
	ctx: MutationCtx,
	args: { contactId: Id<'contacts'>; exempt: boolean; actorUserId: string; now: number }
): Promise<boolean> {
	const contact = await ctx.db.get(args.contactId);
	if (!contact || contact.deletedAt !== undefined) return false;

	await ctx.db.patch(contact._id, {
		// An explicit `undefined` is not a storable Convex value; patching the
		// field to `undefined` is how Convex clears it.
		sunsetExemptAt: args.exempt ? args.now : undefined,
	});

	await recordAuditLog(ctx, {
		userId: args.actorUserId,
		action: 'contact.sunset_exemption_changed',
		resource: 'contact',
		resourceId: contact._id,
		details: { email: contact.email ?? '', exempt: args.exempt },
	});

	return true;
}
