/**
 * Topic membership: `/api/v1/topics/{topicId}/contacts[/{emailOrId}]`.
 *
 * Email syntax and the contact ID format are the server's own checks, applied
 * after decoding.
 */

import { z } from 'zod';
import { requestBody } from './common';
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
	.meta({ anyOf: [{ required: ['email'] }, { required: ['contactId'] }] });

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
