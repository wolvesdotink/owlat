/**
 * Contact-activity type catalog — single source of truth.
 *
 * Previously the literal list lived in three places:
 * - `schema/contacts.ts` `contactActivities.activityType` union (12 literals)
 * - `contacts/activities.ts` `create` mutation args union (only 10 literals
 *   — `inbound_received` / `inbound_replied` were missing, so callers
 *   couldn't insert those activity types through the public mutation)
 * - dashboard formatter switches in `analytics/dashboard.ts`
 *
 * The catalog below collapses the schema list. The schema and the mutation
 * args derive from it, so adding an activity type is a one-place change.
 * The previous schema-vs-mutation drift is closed by construction.
 */

import { literalUnion } from '../lib/literalUnion';

export const CONTACT_ACTIVITY_TYPE_LITERALS = [
	'email_sent',
	'email_opened',
	'email_clicked',
	'email_bounced',
	'email_complained',
	'topic_subscribed',
	'topic_unsubscribed',
	// DOI confirmed for a topic
	'topic_confirmed',
	// Contact-level DOI confirmed via admin-attest from external platform
	// (Mailchimp, Klaviyo, etc.). See ADR-0019.
	'doi_attested',
	'property_updated',
	'created',
	// Inbound activities
	'inbound_received',
	'inbound_replied',
] as const;

export type ContactActivityType = (typeof CONTACT_ACTIVITY_TYPE_LITERALS)[number];

/** Convex validator over every activity type, derived from the catalog above. */
export const contactActivityTypeValidator = literalUnion(CONTACT_ACTIVITY_TYPE_LITERALS);
