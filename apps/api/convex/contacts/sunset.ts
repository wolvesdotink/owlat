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
	},
	returns: v.object({
		scanned: v.number(),
		reengaged: v.number(),
		suppressed: v.number(),
		resumed: v.number(),
		isDone: v.boolean(),
		isBudgetExhausted: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const staleBefore = now - SUNSET_STALE_MS;
		const batchSize = Math.max(1, Math.min(args.batchSize ?? SUNSET_BATCH_SIZE, SUNSET_BATCH_SIZE));
		const batchesRemaining = Math.max(
			0,
			Math.min(args.batchesRemaining ?? SUNSET_MAX_BATCHES, SUNSET_MAX_BATCHES)
		);

		const candidates = await ctx.db
			.query('contacts')
			.withIndex('by_sunset_evaluated_at', (q) => q.lt('sunsetEvaluatedAt', staleBefore))
			.order('asc')
			.take(batchSize);

		const policyRows = await loadSunsetPolicyRows(ctx);

		let scanned = 0;
		let reengaged = 0;
		let suppressed = 0;
		let resumed = 0;

		for (const contact of candidates) {
			scanned += 1;
			// Stamp FIRST, unconditionally: a soft-deleted row (or any row we then
			// decide to skip) must still leave the range, or it pins the head of the
			// scan forever and the sweep never advances.
			await ctx.db.patch(contact._id, { sunsetEvaluatedAt: now });
			if (contact.deletedAt !== undefined) continue;

			const policy = await resolveSunsetPolicyForContact(ctx, contact._id, policyRows);
			const { verdict, applied } = await evaluateAndApplySunset(ctx, { contact, policy, now });
			if (!applied) continue;
			if (verdict.action === 'enter_reengagement') reengaged += 1;
			else if (verdict.action === 'suppress') suppressed += 1;
			else if (verdict.action === 'resume') resumed += 1;
		}

		const isDone = candidates.length < batchSize;
		const isBudgetExhausted = !isDone && batchesRemaining <= 1;
		if (!isDone && batchesRemaining > 1) {
			await ctx.scheduler.runAfter(0, internal.contacts.sunset.sweepSunsetPolicy, {
				batchesRemaining: batchesRemaining - 1,
				batchSize,
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

		return { scanned, reengaged, suppressed, resumed, isDone, isBudgetExhausted };
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
 */
export const setSunsetPolicy = authedMutation({
	args: {
		topicId: v.optional(v.id('topics')),
		isEnabled: v.optional(v.boolean()),
		reengageAfterDays: v.optional(v.number()),
		suppressAfterDays: v.optional(v.number()),
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

		// Ordering is checked against the row the save PRODUCES, not against the
		// arguments alone: saving `suppressAfterDays: 90` onto a row that already
		// says `reengageAfterDays: 180` is just as backwards as sending both at
		// once, and the engine would hold on `invalid_policy` forever.
		const mergedReengage = reengageAfterDays ?? existing?.reengageAfterDays;
		const mergedSuppress = suppressAfterDays ?? existing?.suppressAfterDays;
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

		let policyId;
		if (existing) {
			await ctx.db.patch(existing._id, { ...fields, updatedAt: now });
			policyId = existing._id;
		} else {
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
			v.literal('not_sunset_suppressed')
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
