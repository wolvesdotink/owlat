/**
 * Contact-activity type catalog — single source of truth.
 *
 * The `schema/contacts.ts` `contactActivities.activityType` union and the
 * `contacts/activities.ts` `create` mutation args both derive from the list
 * below, so adding an activity type is a one-place change and the two cannot
 * drift: a literal the mutation args lacked could not be inserted through the
 * public mutation.
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
