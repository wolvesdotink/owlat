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
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { throwInvalidInput } from '../_utils/errors';
import {
	evaluateAndApplySunset,
	loadSunsetPolicyRows,
	resolveSunsetPolicyForContact,
	restoreSunsetSuppression,
	setSunsetExemption,
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

/** Contacts one daily tick can converge. */
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
			console.warn(
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
	enabled: v.boolean(),
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
		const globalRow = rows.find((row) => row.topicId === undefined);
		const globalOverride = globalRow
			? {
					enabled: globalRow.enabled,
					reengageAfterDays: globalRow.reengageAfterDays,
					suppressAfterDays: globalRow.suppressAfterDays,
				}
			: undefined;
		const global = resolveSunsetPolicy({ globalOverride });

		const topics = await ctx.db.query('topics').collect(); // bounded: content categories
		const byTopic = new Map<string, (typeof rows)[number]>();
		for (const row of rows) {
			if (row.topicId !== undefined) byTopic.set(row.topicId, row);
		}

		return {
			defaults: { ...SUNSET_POLICY_DEFAULTS },
			global,
			topics: topics.map((topic) => {
				const row = byTopic.get(topic._id);
				return {
					topicId: topic._id,
					topicName: topic.name,
					policy: resolveSunsetPolicy({
						globalOverride,
						topicOverrides: [
							row
								? {
										enabled: row.enabled,
										reengageAfterDays: row.reengageAfterDays,
										suppressAfterDays: row.suppressAfterDays,
									}
								: undefined,
						],
					}),
				};
			}),
		};
	},
});

/**
 * Upsert the deployment-wide row (`topicId` omitted) or one topic's override.
 * Every field is optional: omitting one leaves it inheriting.
 */
export const setSunsetPolicy = authedMutation({
	args: {
		topicId: v.optional(v.id('topics')),
		enabled: v.optional(v.boolean()),
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
		if (
			reengageAfterDays !== undefined &&
			suppressAfterDays !== undefined &&
			suppressAfterDays < reengageAfterDays
		) {
			throwInvalidInput(
				'The suppression window must be at least as long as the re-engagement window'
			);
		}

		const now = Date.now();
		const existing = await ctx.db
			.query('sunsetPolicies')
			.withIndex('by_topic', (q) => q.eq('topicId', args.topicId))
			.first();

		const fields = {
			enabled: args.enabled,
			reengageAfterDays: args.reengageAfterDays,
			suppressAfterDays: args.suppressAfterDays,
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

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'contact.sunset_policy_updated',
			resource: 'settings',
			resourceId: policyId,
			details: {
				topicId: args.topicId ?? 'global',
				enabled: args.enabled ?? null,
				reengageAfterDays: args.reengageAfterDays ?? null,
				suppressAfterDays: args.suppressAfterDays ?? null,
			},
		});

		return policyId;
	},
});

/** Restore one auto-suppressed contact. One action, audited, and it sets the override. */
export const restoreSunsetContact = authedMutation({
	args: { contactId: v.id('contacts') },
	returns: v.object({
		restored: v.boolean(),
		removedSuppression: v.boolean(),
		reason: v.union(
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
