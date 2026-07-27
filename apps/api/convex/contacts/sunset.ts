/**
 * Sunset policy — the sweep cron and the operator surface (deliverability plan
 * P4-4). The decision lives in `sunsetPolicy.ts` (pure), the reads and writes
 * in `sunsetEngine.ts`; this file is the thin Convex shell around both.
 *
 * THE SWEEP IS A BOUNDED, RESUMABLE SCAN — never a full-table walk. It ranges
 * the `contacts.by_sunset_evaluated_at` index for rows whose stamp is older
 * than `SUNSET_STALE_MS` (never-evaluated rows sort first, because a missing
 * field precedes every number in a Convex index), takes a fixed batch, stamps
 * every row it looks at, and chains itself while a batch budget remains. The
 * stamp IS the cursor: an evaluated contact leaves the range, so a settled
 * contact is not rescanned until it goes stale again. This is the same shape as
 * the engagement-score backfill (`analytics/engagementScoreSync.ts`) on
 * purpose — one proven pattern, not two.
 */

import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { internalMutation } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { logWarn } from '../lib/runtimeLog';
import { throwInvalidInput } from '../_utils/errors';
import {
	evaluateAndApplySunset,
	loadSunsetPolicyRows,
	resolveSunsetPolicyForContact,
	restoreSunsetSuppression,
	setSunsetExemption,
	toSunsetOverride,
} from './sunsetEngine';
import {
	SUNSET_MIN_WINDOW_DAYS,
	SUNSET_POLICY_DEFAULTS,
	resolveSunsetPolicy,
} from './sunsetPolicy';

/** A contact is re-evaluated at most once a day. */
export const SUNSET_STALE_MS = 24 * 60 * 60 * 1000;

/** Contacts inspected per transaction. Keeps one batch inside the read budget. */
export const SUNSET_BATCH_SIZE = 50;

/** Chained batches per tick — the hard ceiling on one sweep's work. */
export const SUNSET_MAX_BATCHES = 20;

/**
 * Contacts one tick can converge: 50 x 20 = 1000.
 *
 * THROUGHPUT. The cron runs HOURLY, so the sustained ceiling is ~24,000
 * contacts a day while `SUNSET_STALE_MS` still guarantees any one contact is
 * evaluated at most once a day. A daily cron would have capped the whole
 * deployment at 1000 contacts a day: past that the stale range never drains,
 * every tick logs the budget warning, and a contact quiet past the suppression
 * window is acted on days late.
 */
export const SUNSET_CONTACTS_PER_TICK = SUNSET_BATCH_SIZE * SUNSET_MAX_BATCHES;

/**
 * THE BLAST-RADIUS CEILING: how many contacts ONE tick may auto-suppress.
 *
 * The engine's per-contact guards are all about whether THIS contact is quiet.
 * None of them can notice that the answer has suddenly become "yes" for the
 * entire book at once, which is what a jumped clock, a bad import that
 * back-dates every activity, or a mis-saved policy all look like. This is the
 * bound on that whole CLASS of mistake: past it the tick stops suppressing,
 * stops chaining, records what it refused, and lets the next hour retry.
 *
 * 100 of a 1000-contact tick — deliberately well below the tick's capacity, so a
 * systemic mis-evaluation is caught in the first tick rather than the tenth. A
 * genuine backlog (a real book that really is that quiet) drains at 100 an hour
 * with an audit trail at every step, which is the pace this decision deserves.
 */
export const SUNSET_MAX_SUPPRESSIONS_PER_TICK = 100;

// ─── The sweep ──────────────────────────────────────────────────────────────

/**
 * Evaluate the stalest contacts against their resolved sunset policy.
 *
 * `batchSize` is caller-supplied only so tests can shrink it, and is CLAMPED to
 * `SUNSET_BATCH_SIZE` — the clamp is what keeps a single transaction inside the
 * read budget, and a throw here would wedge the chain permanently (the rollback
 * would re-present the identical head next tick).
 */
export const sweepSunsetPolicy = internalMutation({
	args: {
		batchesRemaining: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		/** Suppressions already applied earlier in THIS tick's chain. */
		suppressedSoFar: v.optional(v.number()),
		/**
		 * The tick's second reading of time, computed ONCE at the head of the chain
		 * and carried down. Recomputing it per batch would be self-defeating: the
		 * previous batch stamped its rows with the (possibly wrong) `now`, so batch
		 * two would be corroborating this clock against itself.
		 */
		corroboratingInstant: v.optional(v.number()),
	},
	returns: v.object({
		scanned: v.number(),
		reengaged: v.number(),
		suppressed: v.number(),
		resumed: v.number(),
		/** Suppress verdicts refused by the per-tick ceiling; retried next tick. */
		deferredSuppressions: v.number(),
		isDone: v.boolean(),
		isBudgetExhausted: v.boolean(),
		isSuppressionCeilingHit: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const staleBefore = now - SUNSET_STALE_MS;
		const batchSize = Math.max(1, Math.min(args.batchSize ?? SUNSET_BATCH_SIZE, SUNSET_BATCH_SIZE));
		const batchesRemaining = Math.max(
			0,
			Math.min(args.batchesRemaining ?? SUNSET_MAX_BATCHES, SUNSET_MAX_BATCHES)
		);
		const suppressedSoFar = Math.max(0, args.suppressedSoFar ?? 0);

		const candidates = await ctx.db
			.query('contacts')
			.withIndex('by_sunset_evaluated_at', (q) => q.lt('sunsetEvaluatedAt', staleBefore))
			.order('asc')
			.take(batchSize);

		// THE SECOND READING OF TIME (see `SunsetFacts.corroboratingInstant`): the
		// freshest evaluation stamp in the table, written by an earlier tick under
		// an earlier reading of the clock. Same index, opposite end, one row — so
		// the guard against a jumped host clock costs a single point read per
		// batch. Absent on a deployment that has never swept, which is exactly the
		// case the ceiling below covers instead.
		const newestEvaluated =
			args.corroboratingInstant === undefined
				? await ctx.db
						.query('contacts')
						.withIndex('by_sunset_evaluated_at')
						.order('desc')
						.first()
				: null;
		const corroboratingInstant = args.corroboratingInstant ?? newestEvaluated?.sunsetEvaluatedAt;

		const policyRows = await loadSunsetPolicyRows(ctx);

		let scanned = 0;
		let reengaged = 0;
		let suppressed = 0;
		let resumed = 0;
		let deferredSuppressions = 0;
		let isSuppressionCeilingHit = false;

		for (const contact of candidates) {
			scanned += 1;
			// Stamp FIRST, unconditionally: a soft-deleted row (or any row we then
			// decide to skip) must still leave the range, or it pins the head of the
			// scan forever and the sweep never advances.
			const previousEvaluatedAt = contact.sunsetEvaluatedAt;
			await ctx.db.patch(contact._id, { sunsetEvaluatedAt: now });
			if (contact.deletedAt !== undefined) continue;

			const policy = await resolveSunsetPolicyForContact(ctx, contact._id, policyRows);
			const { verdict, applied, deferred } = await evaluateAndApplySunset(ctx, {
				contact,
				policy,
				now,
				...(corroboratingInstant !== undefined ? { corroboratingInstant } : {}),
				canSuppress: suppressedSoFar + suppressed < SUNSET_MAX_SUPPRESSIONS_PER_TICK,
			});

			if (deferred) {
				// Put the contact BACK in the stale range — it was not settled, it was
				// refused, and the next tick must be able to reach it. Then stop: the
				// ceiling applies to the whole tick, so there is nothing left for this
				// chain to do that it is allowed to do.
				await ctx.db.patch(contact._id, { sunsetEvaluatedAt: previousEvaluatedAt });
				deferredSuppressions += 1;
				isSuppressionCeilingHit = true;
				break;
			}

			if (!applied) continue;
			if (verdict.action === 'enter_reengagement') reengaged += 1;
			else if (verdict.action === 'suppress') suppressed += 1;
			else if (verdict.action === 'resume') resumed += 1;
		}

		const isDone = !isSuppressionCeilingHit && candidates.length < batchSize;
		const isBudgetExhausted = !isDone && !isSuppressionCeilingHit && batchesRemaining <= 1;
		if (!isDone && !isSuppressionCeilingHit && batchesRemaining > 1) {
			await ctx.scheduler.runAfter(0, internal.contacts.sunset.sweepSunsetPolicy, {
				batchesRemaining: batchesRemaining - 1,
				batchSize,
				suppressedSoFar: suppressedSoFar + suppressed,
				...(corroboratingInstant !== undefined ? { corroboratingInstant } : {}),
			});
		}

		if (isBudgetExhausted) {
			// The chain's return value is dropped, so a log line is the only way an
			// operator learns the book is bigger than one tick's capacity.
			logWarn(
				`[sunsetSweep] tick exhausted its ${SUNSET_MAX_BATCHES}-batch budget ` +
					`(~${SUNSET_CONTACTS_PER_TICK} contacts) with stale contacts still queued; ` +
					`contacts re-evaluate on a longer cycle than ${SUNSET_STALE_MS}ms`
			);
		}

		// THE OPERATOR-FACING SUMMARY OF THE TICK. Per-contact rows answer "why was
		// this address suppressed"; this one answers the question nobody can ask a
		// per-contact row — "did the engine just suppress a hundred people, and
		// why". It is written only when the tick actually did something
		// irreversible or refused to, so a quiet deployment writes nothing.
		if (suppressed > 0 || deferredSuppressions > 0) {
			await recordAuditLog(ctx, {
				userId: 'system',
				action: 'contact.sunset_sweep_summary',
				resource: 'settings',
				resourceId: 'sunset_sweep',
				details: {
					actor: 'sunset_engine',
					scanned,
					suppressed,
					reengaged,
					resumed,
					deferredSuppressions,
					suppressionCeiling: SUNSET_MAX_SUPPRESSIONS_PER_TICK,
					isSuppressionCeilingHit,
					message: isSuppressionCeilingHit
						? `Auto-suppression paused: this sweep reached its ceiling of ` +
							`${SUNSET_MAX_SUPPRESSIONS_PER_TICK} suppressions. Review the suppressed ` +
							`contacts and the sunset policy before the next hourly sweep resumes; ` +
							`restore any contact from the suppression list in one action.`
						: `${suppressed} contact(s) auto-suppressed after the configured quiet ` +
							`window. Review or restore them from the suppression list.`,
				},
			});
		}

		if (isSuppressionCeilingHit) {
			logWarn(
				`[sunsetSweep] suppression ceiling of ${SUNSET_MAX_SUPPRESSIONS_PER_TICK} reached; ` +
					`stopped this tick with ${deferredSuppressions} suppression(s) deferred`
			);
		}

		return {
			scanned,
			reengaged,
			suppressed,
			resumed,
			deferredSuppressions,
			isDone,
			isBudgetExhausted,
			isSuppressionCeilingHit,
		};
	},
});

// ─── Operator surface ───────────────────────────────────────────────────────

const policyShape = v.object({
	isEnabled: v.boolean(),
	reengageAfterDays: v.number(),
	suppressAfterDays: v.number(),
});

/**
 * The deployment-wide policy plus every per-topic override, already merged onto
 * the defaults so the UI renders effective values rather than a sparse row.
 */
export const getSunsetPolicies = authedQuery({
	args: {},
	returns: v.object({
		defaults: policyShape,
		global: policyShape,
		topics: v.array(
			v.object({
				topicId: v.id('topics'),
				topicName: v.string(),
				policy: policyShape,
			})
		),
	}),
	handler: async (ctx) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can view the sunset policy'
		);
		const rows = await loadSunsetPolicyRows(ctx);
		const globalOverride = toSunsetOverride(rows.find((row) => row.topicId === undefined));
		const global = resolveSunsetPolicy({ globalOverride });

		const topics = await ctx.db.query('topics').collect(); // bounded: content categories
		const byTopic = new Map<string, (typeof rows)[number]>();
		for (const row of rows) {
			if (row.topicId !== undefined) byTopic.set(row.topicId, row);
		}

		return {
			defaults: { ...SUNSET_POLICY_DEFAULTS },
			global,
			topics: topics.map((topic) => ({
				topicId: topic._id,
				topicName: topic.name,
				policy: resolveSunsetPolicy({
					globalOverride,
					topicOverrides: [toSunsetOverride(byTopic.get(topic._id))],
				}),
			})),
		};
	},
});

/**
 * Upsert the deployment-wide row (`topicId` omitted) or one topic's override.
 *
 * A PARTIAL SAVE IS PARTIAL. Only the fields the caller actually supplied reach
 * the patch: in Convex, patching a field to an explicit `undefined` DELETES it,
 * so spreading the whole argument object would let a UI that saves one window
 * silently wipe a stored opt-out and re-arm auto-suppression for that topic's
 * members at the next sweep. Omitting a field therefore means "leave it as it
 * is", and clearing an override back to inherited is not something this
 * mutation can do by accident.
 *
 * CLEARING IS THEREFORE EXPLICIT. `clearFields` names the overrides to return to
 * INHERITED. Without it a topic override would be a one-way door: once
 * `reengageAfterDays` is stored on a topic row, nothing could ever put that
 * topic back on the deployment-wide window. Clearing runs AFTER the merge, so a
 * field cannot be set and cleared by the same call, and the audit entry records
 * which fields were cleared alongside which were set.
 */
export const setSunsetPolicy = authedMutation({
	args: {
		topicId: v.optional(v.id('topics')),
		isEnabled: v.optional(v.boolean()),
		reengageAfterDays: v.optional(v.number()),
		suppressAfterDays: v.optional(v.number()),
		clearFields: v.optional(
			v.array(
				v.union(
					v.literal('isEnabled'),
					v.literal('reengageAfterDays'),
					v.literal('suppressAfterDays')
				)
			)
		),
	},
	returns: v.id('sunsetPolicies'),
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can change the sunset policy'
		);

		const { reengageAfterDays, suppressAfterDays } = args;
		if (reengageAfterDays !== undefined && reengageAfterDays < SUNSET_MIN_WINDOW_DAYS) {
			throwInvalidInput(`The re-engagement window must be at least ${SUNSET_MIN_WINDOW_DAYS} days`);
		}
		if (suppressAfterDays !== undefined && suppressAfterDays < SUNSET_MIN_WINDOW_DAYS) {
			throwInvalidInput(`The suppression window must be at least ${SUNSET_MIN_WINDOW_DAYS} days`);
		}

		const now = Date.now();
		const existing = await ctx.db
			.query('sunsetPolicies')
			.withIndex('by_topic', (q) => q.eq('topicId', args.topicId))
			.first();

		const clearFields = args.clearFields ?? [];
		const isCleared = (field: 'isEnabled' | 'reengageAfterDays' | 'suppressAfterDays'): boolean =>
			clearFields.includes(field);

		// Ordering is checked against the row the save PRODUCES, not against the
		// arguments alone: saving `suppressAfterDays: 90` onto a row that already
		// says `reengageAfterDays: 180` is just as backwards as sending both at
		// once, and the engine would hold on `invalid_policy` forever. A CLEARED
		// field produces no stored value at all, so it drops out of the check the
		// same way an absent one does.
		const mergedReengage = isCleared('reengageAfterDays')
			? undefined
			: (reengageAfterDays ?? existing?.reengageAfterDays);
		const mergedSuppress = isCleared('suppressAfterDays')
			? undefined
			: (suppressAfterDays ?? existing?.suppressAfterDays);
		if (
			mergedReengage !== undefined &&
			mergedSuppress !== undefined &&
			mergedSuppress < mergedReengage
		) {
			throwInvalidInput(
				'The suppression window must be at least as long as the re-engagement window'
			);
		}

		const fields: {
			isEnabled?: boolean;
			reengageAfterDays?: number;
			suppressAfterDays?: number;
		} = {
			...(args.isEnabled !== undefined ? { isEnabled: args.isEnabled } : {}),
			...(reengageAfterDays !== undefined ? { reengageAfterDays } : {}),
			...(suppressAfterDays !== undefined ? { suppressAfterDays } : {}),
		};

		// Cleared LAST and as an explicit `undefined`, which is how Convex deletes
		// a field. Applying it after the set-map is what makes "clear wins over
		// set in the same call" a rule rather than an accident of key order.
		const cleared: {
			isEnabled?: undefined;
			reengageAfterDays?: undefined;
			suppressAfterDays?: undefined;
		} = {};
		for (const field of clearFields) cleared[field] = undefined;

		let policyId: Id<'sunsetPolicies'>;
		if (existing) {
			await ctx.db.patch(existing._id, { ...fields, ...cleared, updatedAt: now });
			policyId = existing._id;
		} else {
			// Nothing to clear on a row that does not exist yet — an absent field is
			// already inherited.
			policyId = await ctx.db.insert('sunsetPolicies', {
				...(args.topicId !== undefined ? { topicId: args.topicId } : {}),
				...fields,
				createdAt: now,
				updatedAt: now,
			});
		}

		// Audit the RESULTING row, plus which fields this save actually set. The
		// arguments alone cannot answer "what does the policy say now", and a save
		// that changed one window would otherwise record two meaningless nulls.
		const stored = await ctx.db.get(policyId);
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'contact.sunset_policy_updated',
			resource: 'settings',
			resourceId: policyId,
			details: {
				topicId: args.topicId ?? 'global',
				changedFields: Object.keys(fields).join(',') || 'none',
				clearedFields: clearFields.join(',') || 'none',
				isEnabled: stored?.isEnabled ?? null,
				reengageAfterDays: stored?.reengageAfterDays ?? null,
				suppressAfterDays: stored?.suppressAfterDays ?? null,
			},
		});

		return policyId;
	},
});

/**
 * WHO IS ON THE TRACK. Paginated over `contacts.by_sunset_stage`, so an
 * operator can enumerate the contacts the engine just moved onto the
 * re-engagement track (or auto-suppressed) and build a win-back send from them.
 * Without this the stage is a write-only field and the "track" is a label
 * nothing can address.
 *
 * Soft-deleted rows are filtered out of the returned page rather than the index
 * range: `deletedAt` is not part of the key, and the page size is already
 * bounded by the caller's `numItems`.
 */
export const listSunsetStage = authedQuery({
	args: {
		stage: v.union(v.literal('reengagement'), v.literal('suppressed')),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.object({
		page: v.array(
			v.object({
				contactId: v.id('contacts'),
				email: v.union(v.string(), v.null()),
				firstName: v.union(v.string(), v.null()),
				lastName: v.union(v.string(), v.null()),
				sunsetStage: v.union(
					v.literal('engaged'),
					v.literal('reengagement'),
					v.literal('suppressed')
				),
				sunsetStageAt: v.union(v.number(), v.null()),
				isExempt: v.boolean(),
			})
		),
		isDone: v.boolean(),
		continueCursor: v.string(),
		// Convex's paginate() carries this through on a split page; declaring the
		// validator without it makes a split page fail to serialize.
		splitCursor: v.optional(v.union(v.string(), v.null())),
		pageStatus: v.optional(
			v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())
		),
	}),
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can view the sunset track'
		);
		const page = await ctx.db
			.query('contacts')
			.withIndex('by_sunset_stage', (q) => q.eq('sunsetStage', args.stage))
			.order('desc')
			.paginate(args.paginationOpts);

		return {
			...page,
			page: page.page
				.filter((contact) => contact.deletedAt === undefined)
				.map((contact) => ({
					contactId: contact._id,
					email: contact.email ?? null,
					firstName: contact.firstName ?? null,
					lastName: contact.lastName ?? null,
					sunsetStage: contact.sunsetStage ?? 'engaged',
					sunsetStageAt: contact.sunsetStageAt ?? null,
					isExempt: contact.sunsetExemptAt !== undefined,
				})),
		};
	},
});

/** Restore one auto-suppressed contact. One action, audited, and it sets the override. */
export const restoreSunsetContact = authedMutation({
	args: { contactId: v.id('contacts') },
	returns: v.object({
		restored: v.boolean(),
		removedSuppression: v.boolean(),
		outcome: v.union(
			v.literal('restored'),
			v.literal('not_found'),
			v.literal('no_email'),
			v.literal('not_sunset_suppressed'),
			v.literal('not_suppressed')
		),
	}),
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can restore a suppressed contact'
		);
		return await restoreSunsetSuppression(ctx, {
			contactId: args.contactId,
			actorUserId: session.userId,
			now: Date.now(),
		});
	},
});

/** Turn the per-contact operator override on or off. */
export const setSunsetContactExemption = authedMutation({
	args: { contactId: v.id('contacts'), exempt: v.boolean() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can change a contact exemption'
		);
		return await setSunsetExemption(ctx, {
			contactId: args.contactId,
			exempt: args.exempt,
			actorUserId: session.userId,
			now: Date.now(),
		});
	},
});
