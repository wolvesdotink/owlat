/**
 * Sunset engine — the ctx-bound half of the sunset policy (deliverability plan
 * P4-4). The decision itself lives in the pure `sunsetPolicy.ts`; this module
 * only LOADS the facts, CALLS the decision, and WRITES the consequence, so the
 * interesting logic stays testable without a database (D15).
 *
 * WHAT IT REUSES RATHER THAN REBUILDS:
 *   - "which activities count as engagement" — `analytics/engagementActivity.ts`
 *     (the P0-2 mapping table). This module derives its literals from that
 *     table BY EXCLUSION, so adding a new positive engagement activity type
 *     reaches the sunset engine automatically and no second definition of
 *     "engaged" exists.
 *   - suppression — `lib/suppression.ts`'s `suppressEmail`, i.e. the SHIPPED
 *     `blockedEmails` row plus the MTA mirror. There is no parallel suppression
 *     concept, no second list, and every existing send-time gate already
 *     honours the row this engine writes.
 *   - the audit trail — `lib/auditLog.ts`'s `recordAuditLog`, with
 *     `userId: 'system'` and an explicit `actor: 'sunset_engine'` detail, so
 *     "the engine did it" is a first-class answer to "who".
 *
 * BOUNDED READS. Every fact is a single-row read on an index whose key ends in
 * the field being ordered by, so the per-contact cost is a small constant
 * regardless of how long the contact's timeline is. Nothing here collects a
 * table.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import {
	CONTACT_ACTIVITY_TYPE_LITERALS,
	type ContactActivityType,
} from '../contactActivities/catalog';
import { ENGAGEMENT_ACTIVITY_MAP } from '../analytics/engagementActivity';
import { recordAuditLog } from '../lib/auditLog';
import { isSuppressed, suppressEmail } from '../lib/suppression';
import {
	evaluateSunset,
	latestSunsetInstant,
	resolveSunsetPolicy,
	type SunsetClock,
	type SunsetFacts,
	type SunsetPolicy,
	type SunsetMeasuredVerdict,
	type SunsetPolicyOverride,
	type SunsetStage,
	type SunsetVerdict,
} from './sunsetPolicy';

/**
 * The activity literals that count as the contact ENGAGING with us, derived
 * from the P0-2 mapping table.
 *
 * DEFINED BY EXCLUSION, ON PURPOSE. The rule is "every literal the engagement
 * machinery reacts to, except the two NEGATIVE ones", not an allow-list of the
 * kinds that exist today. An allow-list would silently drop a future positive
 * kind out of the sunset engine while `ENGAGEMENT_ACTIVITY_MAP` counted it —
 * two disagreeing definitions of "engaged", which is exactly what this module
 * exists not to have. `null` literals (a send is our action, not theirs) are
 * excluded by the same expression.
 *
 * Module-private: the quiet clock is reset by the WIDER set below, and exporting
 * both would invite a caller to pick the wrong one.
 */
const SUNSET_ENGAGEMENT_LITERALS: readonly ContactActivityType[] =
	CONTACT_ACTIVITY_TYPE_LITERALS.filter((literal) => {
		const mapped = ENGAGEMENT_ACTIVITY_MAP[literal];
		return mapped !== null && mapped !== 'bounce' && mapped !== 'complaint';
	});

/**
 * The literals that are an EXPLICIT ACT BY THE CONTACT but carry no open/click
 * weight, so the engagement SCORE correctly maps them to `null`.
 *
 * The score is an accumulator for "how warm is this address"; the sunset clock
 * answers a different question — "is anyone home". Signing up, confirming a
 * double opt-in, being admin-attested as confirmed, or writing to us are all
 * unambiguous evidence that someone is home, and none of them belongs in a
 * warmth score. Judging the quiet window by the score's literals alone means an
 * old, long-quiet contact who fills in the signup form today still measures
 * three hundred quiet days and is auto-suppressed by the next sweep — before the
 * confirmation mail they are owed has even been read.
 */
const SUNSET_CONSENT_LITERALS = [
	'topic_subscribed',
	'topic_confirmed',
	'doi_attested',
	'inbound_received',
] as const satisfies readonly ContactActivityType[];

const SUNSET_CONSENT_LITERAL_SET: ReadonlySet<string> = new Set(SUNSET_CONSENT_LITERALS);

/**
 * THE ONE TABLE OF "WHAT RESETS THE QUIET CLOCK": every engagement literal plus
 * every explicit-consent / inbound literal, in catalog order.
 *
 * Still derived from `CONTACT_ACTIVITY_TYPE_LITERALS` rather than hand-listed,
 * so a renamed or removed catalog literal breaks the build here instead of
 * silently shrinking the set. `__tests__/sunsetPolicy.test.ts` pins its exact
 * contents, so a catalog change that drops one of them fails the suite too.
 */
export const SUNSET_QUIET_RESETTING_LITERALS: readonly ContactActivityType[] =
	CONTACT_ACTIVITY_TYPE_LITERALS.filter(
		(literal) =>
			SUNSET_ENGAGEMENT_LITERALS.includes(literal) || SUNSET_CONSENT_LITERAL_SET.has(literal)
	);

export type SunsetTransition = {
	verdict: SunsetVerdict;
	/** True when the verdict actually changed something. `hold` never does. */
	applied: boolean;
	/**
	 * True when a `suppress` verdict was REFUSED by the caller's blast-radius
	 * ceiling rather than by the decision itself. The caller is expected to leave
	 * the contact unsettled so a later tick can retry it, and to surface the
	 * refusal — a suppression that silently does not happen is as confusing as
	 * one that silently does.
	 */
	deferred: boolean;
};

// ─── Policy loading ─────────────────────────────────────────────────────────

export type SunsetPolicyRow = Doc<'sunsetPolicies'>;

/**
 * Project a stored row onto the pure core's override shape. Exported because
 * the operator query renders effective policies through the same resolver and
 * must not re-spell this projection.
 */
export function toSunsetOverride(
	row: SunsetPolicyRow | undefined
): SunsetPolicyOverride | undefined {
	if (row === undefined) return undefined;
	return {
		isEnabled: row.isEnabled,
		reengageAfterDays: row.reengageAfterDays,
		suppressAfterDays: row.suppressAfterDays,
	};
}

/**
 * Load every override row. The table holds at most one row per topic plus one
 * deployment-wide row, so a single collect is the right shape — and an EMPTY
 * table is the shipped default configuration, not a missing setup.
 */
export async function loadSunsetPolicyRows(
	ctx: QueryCtx | MutationCtx
): Promise<readonly SunsetPolicyRow[]> {
	return await ctx.db.query('sunsetPolicies').collect(); // bounded: one row per topic + one global
}

/**
 * THE SECOND READING OF TIME, derived in ONE place.
 *
 * Two callers need it and must never disagree about it: the sweep judges its
 * `Date.now()` against it before writing anything, and `getSunsetPolicies`
 * reports the resulting stall to the operator. A screen that says the engine is
 * running while the sweep is refusing to run — or the reverse — is worse than
 * either answer alone, so the corroboration sources are folded here and nowhere
 * else.
 *
 * The sources are the freshest evaluation stamp this deployment wrote (newest
 * first on `by_sunset_evaluated_at`) and the operator's explicit re-arm
 * (`sunsetPolicies.clockVerifiedAt` on the global row); the LATER of the two
 * wins. `undefined` means "no second reading available" — a deployment that has
 * never swept — which holds nobody.
 */
export async function loadSunsetCorroboratingInstant(
	ctx: QueryCtx | MutationCtx,
	policyRows: readonly SunsetPolicyRow[]
): Promise<number | undefined> {
	const newestEvaluated = await ctx.db
		.query('contacts')
		.withIndex('by_sunset_evaluated_at')
		.order('desc')
		.first();
	return latestSunsetInstant(
		newestEvaluated?.sunsetEvaluatedAt,
		policyRows.find((row) => row.topicId === undefined)?.clockVerifiedAt
	);
}

/**
 * The policy one contact is judged by: the deployment-wide row, with the rows
 * of every topic the contact belongs to layered on top and combined by
 * `resolveSunsetPolicy` (most lenient wins — see its docstring).
 */
export async function resolveSunsetPolicyForContact(
	ctx: QueryCtx | MutationCtx,
	contactId: Id<'contacts'>,
	rows: readonly SunsetPolicyRow[]
): Promise<SunsetPolicy> {
	const globalRow = rows.find((row) => row.topicId === undefined);
	const globalOverride = toSunsetOverride(globalRow);
	const byTopic = new Map<string, SunsetPolicyRow>();
	for (const row of rows) {
		if (row.topicId !== undefined) byTopic.set(row.topicId, row);
	}

	// SHORT-CIRCUIT ON THE SHIPPED DEFAULT. With no per-topic override stored —
	// the out-of-the-box configuration — a contact's memberships cannot change
	// the answer, so reading them would be one wasted index query per contact per
	// batch for every install that never tuned a topic.
	if (byTopic.size === 0) return resolveSunsetPolicy({ globalOverride });

	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one row per topic the contact subscribes to

	const topicOverrides = memberships.map((membership) =>
		toSunsetOverride(byTopic.get(membership.topicId))
	);

	return resolveSunsetPolicy({
		globalOverride,
		...(topicOverrides.length > 0 ? { topicOverrides } : {}),
	});
}

// ─── Fact loading ───────────────────────────────────────────────────────────

/**
 * Newest `occurredAt` across every quiet-clock-resetting activity, or undefined.
 *
 * EXACT, NOT PROBED. The read goes through `by_contact_type_and_occurred_at`,
 * whose key ends in `occurredAt`, so `.order('desc').first()` per literal IS the
 * newest engagement of that kind — one row each, a fixed handful of reads, and
 * no dependence on insertion order. `by_contact_and_type` would order by
 * `_creationTime` instead, which a CSV import or a replayed webhook batch
 * backfilling historical opens reorders arbitrarily; under-reporting the newest
 * engagement inflates the quiet window and can auto-suppress an actively
 * engaged contact, so this read has to be exact rather than approximately right.
 */
async function loadLastQuietResetAt(
	ctx: QueryCtx | MutationCtx,
	contactId: Id<'contacts'>
): Promise<number | undefined> {
	let newest: number | undefined;
	for (const literal of SUNSET_QUIET_RESETTING_LITERALS) {
		const row = await ctx.db
			.query('contactActivities')
			.withIndex('by_contact_type_and_occurred_at', (q) =>
				q.eq('contactId', contactId).eq('activityType', literal)
			)
			.order('desc')
			.first();
		if (row === null || !Number.isFinite(row.occurredAt)) continue;
		if (newest === undefined || row.occurredAt > newest) newest = row.occurredAt;
	}
	return newest;
}

/**
 * Gather everything `evaluateSunset` needs for one contact. Every absent fact
 * stays `undefined` / `false` — the decision core treats that as "unmeasured"
 * and holds, which is exactly the behaviour the empty-history guard needs.
 */
export async function loadSunsetFacts(
	ctx: QueryCtx | MutationCtx,
	contact: Doc<'contacts'>,
	clock: SunsetClock
): Promise<SunsetFacts> {
	const rawEmail = contact.email;
	const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
	const hasEmail = email.length > 0;
	const isAlreadySuppressed = hasEmail ? await isSuppressed(ctx, email) : false;

	// Same index, same reason as `loadLastEngagementAt`: the OLDEST send by
	// `occurredAt`, not the first one that happened to be written.
	const firstSend = await ctx.db
		.query('contactActivities')
		.withIndex('by_contact_type_and_occurred_at', (q) =>
			q.eq('contactId', contact._id).eq('activityType', 'email_sent')
		)
		.order('asc')
		.first();

	const lastEngagementAt = await loadLastQuietResetAt(ctx, contact._id);

	return {
		...clock,
		createdAt: contact.createdAt,
		...(lastEngagementAt !== undefined ? { lastEngagementAt } : {}),
		...(firstSend !== null ? { firstMessagedAt: firstSend.occurredAt } : {}),
		hasSendHistory: firstSend !== null,
		hasEmail,
		isGloballyUnsubscribed: contact.unsubscribedAt !== undefined,
		isAlreadySuppressed,
		isExempt: contact.sunsetExemptAt !== undefined,
		stage: contact.sunsetStage ?? 'engaged',
	};
}

// ─── Applying a verdict ─────────────────────────────────────────────────────

/**
 * Only a MEASURED verdict is ever audited — a hold changes nothing and has no
 * day counts to report — so every number below is real and none of them needs a
 * sentinel.
 */
function auditDetails(
	contact: Doc<'contacts'>,
	verdict: SunsetMeasuredVerdict
): Record<string, string | number | boolean | null> {
	return {
		actor: 'sunset_engine',
		email: contact.email ?? '',
		reason: verdict.reason,
		fromStage: contact.sunsetStage ?? 'engaged',
		toStage: verdict.stage,
		quietDays: Math.round(verdict.quietDays),
		tenureDays: Math.round(verdict.tenureDays),
	};
}

async function setStage(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	stage: SunsetStage,
	now: number
): Promise<void> {
	await ctx.db.patch(contactId, { sunsetStage: stage, sunsetStageAt: now });
}

/**
 * Evaluate one contact and apply the result. `hold` writes nothing beyond the
 * sweep's own freshness stamp (which the caller owns), so a settled contact
 * costs one range read and one patch per sweep.
 *
 * NOTHING HERE DELETES ANYTHING. A suppression is an INSERT into the shipped
 * `blockedEmails` list plus a stage patch on the contact; the contact, its
 * timeline and its topic memberships are untouched and the restore path can put
 * everything back.
 */
export async function evaluateAndApplySunset(
	ctx: MutationCtx,
	args: {
		contact: Doc<'contacts'>;
		policy: SunsetPolicy;
		/** The tick's single reading of time — see `SunsetClock`. */
		clock: SunsetClock;
		/**
		 * The caller's blast-radius ceiling. `false` means "you may move this
		 * contact onto the re-engagement track, but do NOT suppress it in this
		 * pass" — the reversible half of the policy keeps running while the
		 * irreversible half is held back. Defaults to allowed.
		 */
		canSuppress?: boolean | undefined;
	}
): Promise<SunsetTransition> {
	const { contact, policy, clock } = args;
	const now = clock.now;
	const facts = await loadSunsetFacts(ctx, contact, clock);
	const verdict = evaluateSunset(facts, policy);

	switch (verdict.action) {
		case 'hold':
			return { verdict, applied: false, deferred: false };

		case 'resume': {
			await setStage(ctx, contact._id, 'engaged', now);
			await recordAuditLog(ctx, {
				userId: 'system',
				action: 'contact.sunset_resumed',
				resource: 'contact',
				resourceId: contact._id,
				details: auditDetails(contact, verdict),
			});
			return { verdict, applied: true, deferred: false };
		}

		case 'enter_reengagement': {
			await setStage(ctx, contact._id, 'reengagement', now);
			await recordAuditLog(ctx, {
				userId: 'system',
				action: 'contact.sunset_reengagement',
				resource: 'contact',
				resourceId: contact._id,
				details: auditDetails(contact, verdict),
			});
			return { verdict, applied: true, deferred: false };
		}

		case 'suppress': {
			// Guarded twice on purpose: the decision core already refuses to
			// suppress a contact with no address, and the write path refuses again
			// rather than trusting it.
			const email = contact.email;
			if (email === undefined || email.trim().length === 0) {
				return { verdict, applied: false, deferred: false };
			}
			// THE BLAST-RADIUS CEILING. Suppression is the one irreversible-feeling
			// thing this engine does, so the caller gets to say "not any more in
			// this pass" — and the refusal is reported rather than swallowed.
			if (args.canSuppress === false) {
				return { verdict, applied: false, deferred: true };
			}
			await suppressEmail(ctx, {
				email,
				reason: 'unengaged',
				notes:
					`Sunset policy: no engagement for ${Math.round(verdict.quietDays)} days ` +
					`(threshold ${policy.suppressAfterDays})`,
				now,
			});
			await setStage(ctx, contact._id, 'suppressed', now);
			await recordAuditLog(ctx, {
				userId: 'system',
				action: 'contact.sunset_suppressed',
				resource: 'contact',
				resourceId: contact._id,
				details: auditDetails(contact, verdict),
				// The full decision snapshot, so an operator asking "why was this
				// address suppressed" gets every input the engine saw, not a summary.
				detailsBlob: JSON.stringify({ facts, policy, verdict }),
			});
			return { verdict, applied: true, deferred: false };
		}
	}
}
