/**
 * Sunset policy — the OPERATOR surface (deliverability plan P4-4). The decision
 * lives in `sunsetPolicy.ts` (pure), the per-contact reads and writes in
 * `sunsetEngine.ts`, the restore/exemption paths in `sunsetRestore.ts`, and the
 * hourly cron in `sunsetSweep.ts`; this file is what a person can call.
 */

import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import type { Id } from '../_generated/dataModel';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { throwInvalidInput } from '../_utils/errors';
import { loadSunsetPolicyRows, toSunsetOverride } from './sunsetEngine';
import { restoreSunsetSuppression, setSunsetExemption } from './sunsetRestore';
import {
	SUNSET_MIN_WINDOW_DAYS,
	SUNSET_POLICY_DEFAULTS,
	isClockCorroborated,
	latestSunsetInstant,
	resolveSunsetPolicy,
} from './sunsetPolicy';

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
		/**
		 * Whether the hourly sweep is currently refusing to run because the clock
		 * is not corroborated, and when an operator last confirmed the clock. This
		 * is the only place the stall is visible to a person: without it the engine
		 * is silently off and the audit trail is the only clue.
		 */
		clock: v.object({
			isSweepStalled: v.boolean(),
			verifiedAt: v.union(v.number(), v.null()),
		}),
	}),
	handler: async (ctx) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can view the sunset policy'
		);
		const rows = await loadSunsetPolicyRows(ctx);
		const globalRow = rows.find((row) => row.topicId === undefined);
		const globalOverride = toSunsetOverride(globalRow);
		const global = resolveSunsetPolicy({ globalOverride });

		const newestEvaluated = await ctx.db
			.query('contacts')
			.withIndex('by_sunset_evaluated_at')
			.order('desc')
			.first();
		const corroboratingInstant = latestSunsetInstant(
			newestEvaluated?.sunsetEvaluatedAt,
			globalRow?.clockVerifiedAt
		);

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
			clock: {
				isSweepStalled: !isClockCorroborated(Date.now(), corroboratingInstant),
				verifiedAt: globalRow?.clockVerifiedAt ?? null,
			},
		};
	},
});

/**
 * "I have checked this deployment's clock" — the operator's re-arm for a
 * stalled sweep.
 *
 * The sweep refuses to run when `Date.now()` is not corroborated by the
 * freshest evaluation stamp, AND the sweep is the only writer of those stamps.
 * A deployment that was paused (or restored from a backup) for longer than the
 * tolerance therefore cannot recover on its own — the guard would hold forever
 * and a feature that ships ON would be silently off. This mutation is the way
 * out, and it is deliberately a HUMAN action: the machine cannot distinguish
 * "the clock jumped" from "nobody ran this for two months", so a person says
 * which it was, and the saying is audited.
 *
 * It records a fresh instant on the deployment-wide row; the sweep treats that
 * as the later corroboration source and runs on its next tick, writing real
 * stamps again from then on. Nothing else about the policy changes, and no
 * contact is suppressed by this call.
 */
export const confirmSunsetClock = authedMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const session = await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can confirm the sunset clock'
		);

		const now = Date.now();
		const existing = await ctx.db
			.query('sunsetPolicies')
			.withIndex('by_topic', (q) => q.eq('topicId', undefined))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { clockVerifiedAt: now, updatedAt: now });
		} else {
			await ctx.db.insert('sunsetPolicies', {
				clockVerifiedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		}

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'contact.sunset_clock_confirmed',
			resource: 'settings',
			resourceId: 'sunset_sweep',
			details: {
				clockVerifiedAt: now,
				message:
					`An operator confirmed this deployment's clock, so the sunset sweep ` +
					`resumes from its next hourly tick.`,
			},
		});

		return now;
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
