/**
 * Send-time profile — the database half (ADR-0068). The arithmetic is in
 * `sendTimeProfile.ts`; this module places an engagement in local time, folds
 * it into the contact's profile and into one shard of the organization
 * histogram, and sums those shards for the planner.
 *
 * The send lifecycle schedules `recordEngagement` for the first reader open
 * (pixel judged to be a mail client) and the first reader click of each
 * campaign send; the backfill migration (0064) rebuilds profiles from the
 * sends that already exist.
 */

import { v } from 'convex/values';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { localTimeParts } from '../lib/emailHelpers';
import { STAT_SHARD_COUNT } from '../lib/statShards';
import {
	addHistograms,
	effectiveTimeZone,
	emptyHistogram,
	foldEngagement,
	isWellFormedHistogram,
	type SendTimeEngagementKind,
	type SendTimeHistogram,
	type SendTimeProfile,
} from './sendTimeProfile';

/** The organization's zone (General settings), the fallback for contacts without one. */
export async function readDefaultTimezone(db: DatabaseReader): Promise<string | undefined> {
	const settings = await db.query('instanceSettings').first();
	return settings?.timezone ?? undefined;
}

/**
 * Fold one engagement into a contact's profile. A new profile is bucketed in
 * the contact's zone as it is now and keeps that zone, so its hours stay
 * comparable with each other even if the contact's zone changes later.
 */
export function foldContactEngagement(
	contact: Pick<Doc<'contacts'>, 'timezone' | 'sendTimeProfile'>,
	engagement: { kind: SendTimeEngagementKind; at: number },
	defaultTimezone: string | undefined
): SendTimeProfile {
	const existing = contact.sendTimeProfile;
	const timeZone =
		existing && isWellFormedHistogram(existing)
			? effectiveTimeZone(existing.timeZone, defaultTimezone)
			: effectiveTimeZone(contact.timezone, defaultTimezone);
	const local = localTimeParts(engagement.at, timeZone);
	const folded = foldEngagement(existing, {
		at: engagement.at,
		kind: engagement.kind,
		hour: local.hour,
		weekday: local.weekday,
	});
	return { ...folded, timeZone };
}

/** The local slot an engagement lands in, for the organization histogram. */
export function organizationSlot(
	profile: SendTimeProfile,
	at: number
): { hour: number; weekday: number } {
	const local = localTimeParts(at, profile.timeZone);
	return { hour: local.hour, weekday: local.weekday };
}

/** Add a histogram onto a random organization shard, creating the shard on first use. */
export async function addToOrganizationHistogram(
	ctx: MutationCtx,
	delta: SendTimeHistogram
): Promise<void> {
	const shardKey = Math.floor(Math.random() * STAT_SHARD_COUNT);
	const shard = await ctx.db
		.query('sendTimeHistogramShards')
		.withIndex('by_shard', (q) => q.eq('shardKey', shardKey))
		.first();
	if (!shard) {
		await ctx.db.insert('sendTimeHistogramShards', { shardKey, ...delta });
		return;
	}
	const base = isWellFormedHistogram(shard) ? shard : emptyHistogram(delta.asOf);
	const sum = addHistograms(base, delta);
	await ctx.db.patch(shard._id, {
		hours: sum.hours,
		days: sum.days,
		total: sum.total,
		asOf: sum.asOf,
	});
}

/**
 * The organization histogram: every shard brought to one instant and summed.
 * Null when nothing has been recorded. Bounded by `STAT_SHARD_COUNT` rows.
 */
export async function readOrganizationHistogram(
	db: DatabaseReader
): Promise<SendTimeHistogram | null> {
	const shards = await db.query('sendTimeHistogramShards').take(STAT_SHARD_COUNT * 2);
	let sum: SendTimeHistogram | null = null;
	for (const shard of shards) {
		if (!isWellFormedHistogram(shard)) continue;
		const h = { hours: shard.hours, days: shard.days, total: shard.total, asOf: shard.asOf };
		sum = sum ? addHistograms(sum, h) : h;
	}
	return sum;
}

/** Remove every organization shard (the backfill's fresh pass rebuilds them). */
export async function clearOrganizationHistogram(ctx: MutationCtx): Promise<void> {
	for (const shard of await ctx.db.query('sendTimeHistogramShards').take(STAT_SHARD_COUNT * 2)) {
		await ctx.db.delete(shard._id);
	}
}

/**
 * Fold one reader engagement into the contact's profile and the organization
 * histogram. Scheduled by the send lifecycle; a contact erased in between is
 * simply gone.
 */
export const recordEngagement = internalMutation({
	args: {
		contactId: v.id('contacts'),
		engagement: v.union(v.literal('open'), v.literal('click')),
		at: v.number(),
	},
	handler: async (ctx, args): Promise<void> => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact || contact.deletedAt !== undefined) return;
		const defaultTimezone = await readDefaultTimezone(ctx.db);
		const profile = foldContactEngagement(
			contact,
			{ kind: args.engagement, at: args.at },
			defaultTimezone
		);
		// Only the profile field: `updatedAt` stays, nothing downstream should
		// see the contact as edited.
		await ctx.db.patch(contact._id, { sendTimeProfile: profile });
		const slot = organizationSlot(profile, args.at);
		await addToOrganizationHistogram(
			ctx,
			foldEngagement(null, { at: args.at, kind: args.engagement, ...slot })
		);
	},
});
