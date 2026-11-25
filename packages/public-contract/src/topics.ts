/**
 * Topics: the list at `/api/v1/topics`, and membership at
 * `/api/v1/topics/{topicId}/contacts[/{emailOrId}]`.
 *
 * Email syntax and the contact ID format are the server's own checks, applied
 * after decoding.
 */

import { z } from 'zod';
import { anyNonemptyReference, requestBody } from './common';
import { DOI_STATUSES } from './types';

/**
 * Either reference may be `null` or empty when the other one names the
 * contact; only a request naming neither is refused.
 */
export const addContactToTopicRequestSchema = requestBody({
	email: z.string({ error: 'email must be a string' }).nullish(),
	contactId: z.string({ error: 'contactId must be a string' }).nullish(),
})
	.refine((body) => !!body.email || !!body.contactId, {
		error: 'Either email or contactId is required',
	})
	.meta(anyNonemptyReference('email', 'contactId'));

export const addToTopicResponseSchema = z.strictObject({
	success: z.boolean(),
	contactId: z.string(),
	topicId: z.string(),
	doiStatus: z.enum(DOI_STATUSES),
});

export const removeFromTopicResponseSchema = z.strictObject({
	success: z.boolean(),
	removed: z.boolean(),
});

export const topicSchema = z.strictObject({
	id: z.string().meta({ description: 'The topic ID the membership routes take as topicId.' }),
	name: z.string(),
	description: z
		.string()
		.nullable()
		.meta({ description: 'What the topic is about, or null when it has no description.' }),
	requiresDoubleOptIn: z.boolean().meta({
		description:
			"Whether the topic requires double opt-in: a contact whose subscription is pending double opt-in counts as subscribed once they confirm their address. The add call's doiStatus reports the contact's confirmation state.",
	}),
	createdAt: z.string().meta({ description: 'ISO 8601 timestamp of when the topic was created.' }),
});
