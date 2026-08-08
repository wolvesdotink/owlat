import { defineTable } from 'convex/server';
import { type Infer, v } from 'convex/values';
import type { SndsComplaintBand, SndsFilterResult } from '../delivery/sndsFeed';

/**
 * Microsoft Smart Network Data Services (SNDS) telemetry.
 *
 * One idempotent row per sending IP per UTC day, folded from the feed's
 * sub-day activity windows. The stored complaint signal is a BAND, exactly as
 * Microsoft publishes it — we never widen it into a rate, because the feed
 * does not carry one (see `delivery/sndsFeed.ts`).
 *
 * SNDS is ADDITIVE-ONLY (D2). An operator who never enrolled simply has no
 * rows here: the Microsoft cell then falls back to the outcomes of its own
 * sends, with a doubled dwell time and a one-phase-lower ceiling. That is a
 * supported configuration, never an error state, and it never blocks a send.
 */

export const sndsComplaintBandValidator = v.union(
	v.literal('unknown'),
	v.literal('lt_0_1'),
	v.literal('0_1_to_0_2'),
	v.literal('0_2_to_0_3'),
	v.literal('0_3_to_0_4'),
	v.literal('0_4_to_0_5'),
	v.literal('0_5_to_0_6'),
	v.literal('0_6_to_0_7'),
	v.literal('0_7_to_0_8'),
	v.literal('0_8_to_0_9'),
	v.literal('gte_0_9')
);

export const sndsFilterResultValidator = v.union(
	v.literal('unknown'),
	v.literal('green'),
	v.literal('yellow'),
	v.literal('red')
);

/** Compile-time proof that the stored unions and the parser's stay identical. */
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export type SndsBandUnionsMatch = AssertSame<
	SndsComplaintBand,
	Infer<typeof sndsComplaintBandValidator>
>;
export type SndsFilterUnionsMatch = AssertSame<
	SndsFilterResult,
	Infer<typeof sndsFilterResultValidator>
>;

export const sndsTables = {
	sndsIpDailyStats: defineTable({
		/** Canonical sending IP, as the feed reported it. */
		ip: v.string(),
		/** UTC midnight of the activity day the row folds. */
		periodStart: v.number(),
		complaintBand: sndsComplaintBandValidator,
		filterResult: sndsFilterResultValidator,
		/** Spam-trap hits Microsoft attributed to the IP that day. */
		trapHits: v.number(),
		messageRecipients: v.number(),
		rcptCommands: v.number(),
		dataCommands: v.number(),
		/** A HELO name the feed sampled — operator-facing hygiene, never a key. */
		sampleHelo: v.optional(v.string()),
		/** When the poller read the feed; drives replay and staleness rejection. */
		fetchedAt: v.number(),
		ingestedAt: v.number(),
	})
		.index('by_ip_period', ['ip', 'periodStart'])
		.index('by_period', ['periodStart']),
};
