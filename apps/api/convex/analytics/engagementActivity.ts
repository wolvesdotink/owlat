/**
 * The adapter between the `contactActivities` catalog and the engagement
 * score's own vocabulary (deliverability plan P0-2).
 *
 * It lives beside `engagementScore.ts` rather than inside it so the scoring
 * core stays a closed piece of arithmetic: the core knows six abstract activity
 * KINDS and nothing about which product literal produced them, and this module
 * is the single place that mapping is spelled out.
 */

import type { ContactActivityType } from '../contactActivities/catalog';
import type { EngagementActivity } from './engagementScore';

/**
 * Map a `contactActivities` row onto a scoring activity. Returns `null` for the
 * activity types the score does not react to (topic changes, property edits,
 * `created`, `email_sent` — a send is our action, not the contact's).
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
	switch (args.activityType) {
		case 'email_opened':
			return { kind: 'open', occurredAt: args.occurredAt };
		case 'email_clicked':
			return { kind: 'click', occurredAt: args.occurredAt };
		case 'inbound_replied':
			return { kind: 'reply', occurredAt: args.occurredAt };
		case 'email_complained':
			return { kind: 'complaint', occurredAt: args.occurredAt };
		case 'email_bounced':
			return {
				kind: args.bounceType?.toLowerCase() === 'hard' ? 'hard_bounce' : 'soft_bounce',
				occurredAt: args.occurredAt,
			};
		default:
			return null;
	}
}
