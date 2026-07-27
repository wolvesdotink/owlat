/**
 * The adapter between the `contactActivities` catalog and the engagement
 * score's own vocabulary (deliverability plan P0-2).
 *
 * It lives beside `engagementScore.ts` rather than inside it so the scoring
 * core stays a closed piece of arithmetic: the core knows six abstract activity
 * KINDS and nothing about which product literal produced them, and this module
 * is the single place that mapping is spelled out.
 *
 * This module is also the ONE table of "which catalog literals the score reacts
 * to". `contactActivities/writer.ts` derives its post-insert trigger set from
 * `ENGAGEMENT_ACTIVITY_LITERALS` below rather than re-listing the literals, so
 * adding a mapping here cannot silently leave the hot path not folding it.
 */

import {
	CONTACT_ACTIVITY_TYPE_LITERALS,
	type ContactActivityType,
} from '../contactActivities/catalog';
import type { EngagementActivity, EngagementActivityKind } from './engagementScore';

/**
 * What a catalog literal maps to. `'bounce'` is resolved to `hard_bounce` or
 * `soft_bounce` from the activity's `bounceType` metadata; `null` means the
 * score does not react to the literal at all (topic changes, property edits,
 * `created`, `email_sent` — a send is our action, not the contact's).
 */
export type EngagementActivityMapping = EngagementActivityKind | 'bounce' | null;

/**
 * The mapping table. It is a total `Record` over the catalog union on purpose:
 * adding a literal to `CONTACT_ACTIVITY_TYPE_LITERALS` breaks the build here
 * until someone decides, explicitly, whether the score reacts to it.
 */
export const ENGAGEMENT_ACTIVITY_MAP: Readonly<
	Record<ContactActivityType, EngagementActivityMapping>
> = {
	email_sent: null,
	email_opened: 'open',
	email_clicked: 'click',
	email_bounced: 'bounce',
	email_complained: 'complaint',
	topic_subscribed: null,
	topic_unsubscribed: null,
	topic_confirmed: null,
	doi_attested: null,
	property_updated: null,
	created: null,
	inbound_received: null,
	inbound_replied: 'reply',
};

/**
 * The literals the score reacts to, derived from the table above. This is what
 * the writer's post-insert path gates on — one definition, two consumers.
 */
export const ENGAGEMENT_ACTIVITY_LITERALS: ReadonlySet<ContactActivityType> = new Set(
	CONTACT_ACTIVITY_TYPE_LITERALS.filter((literal) => ENGAGEMENT_ACTIVITY_MAP[literal] !== null)
);

/**
 * Map a `contactActivities` row onto a scoring activity. Returns `null` for the
 * activity types the score does not react to.
 *
 * `bounceType` is free-form on the activity metadata; anything that is not an
 * explicit hard bounce is treated as soft (fail-soft: we would rather under-
 * suppress than zero a healthy contact on an unrecognised label).
 *
 * `activityType` is the catalog union, NOT `string`: renaming a literal must
 * break the build here rather than silently stop the score reacting to opens.
 */
export function toEngagementActivity(args: {
	activityType: ContactActivityType;
	occurredAt: number;
	bounceType?: string | undefined;
}): EngagementActivity | null {
	// `?? null` is not dead: the adversarial suite casts an off-catalog string in
	// on purpose, and an unknown literal must be ignored, never crash the writer.
	const mapped = ENGAGEMENT_ACTIVITY_MAP[args.activityType] ?? null;
	if (mapped === null) return null;
	if (mapped === 'bounce') {
		return {
			kind: args.bounceType?.toLowerCase() === 'hard' ? 'hard_bounce' : 'soft_bounce',
			occurredAt: args.occurredAt,
		};
	}
	return { kind: mapped, occurredAt: args.occurredAt };
}
