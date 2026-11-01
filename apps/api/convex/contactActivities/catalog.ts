/**
 * Contact-activity type catalog — single source of truth.
 *
 * The `schema/contacts.ts` `contactActivities.activityType` validator derives
 * from the list below, and `contactActivities/writer.ts` fails to compile
 * unless its per-literal module map covers exactly these literals, so adding
 * an activity type starts here and the writer cannot drift from the schema.
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
	// (Mailchimp, Klaviyo, etc.).
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
