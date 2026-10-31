/**
 * Transactional sends: `POST /api/v1/transactional`.
 *
 * The schemas check shape only. Email syntax, the envelope byte budget, URL
 * safety, base64 decoding and the decoded-size budget stay with the server,
 * which applies them after decoding and before any attachment byte is stored.
 */

import { z } from 'zod';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import {
	anyNonemptyReference,
	jsonPrimitiveRecordSchema,
	requestBody,
	requiredString,
} from './common';

/**
 * A language tag such as `en`, `de` or `en-US`, either letter case. An empty
 * string is accepted and means "no preference".
 */
export const LANGUAGE_PATTERN = /^(?:[A-Za-z]{2}(?:-[A-Za-z]{2,3})?)?$/;

/** `attachments[i]` for the attachment an issue points into. */
function attachmentAt(path: readonly PropertyKey[]): string {
	return `attachments[${String(path[1] ?? '')}]`;
}

/** No `/` or `\`: a filename names a file, never a path. */
const FILENAME_PATTERN = /^[^/\\]*$/;

export const transactionalAttachmentSchema = z
	.object(
		{
			filename: z
				.string({
					error: (issue) =>
						`${attachmentAt(issue.path ?? [])}.filename is required and must be a string`,
				})
				.min(1, {
					error: (issue) =>
						`${attachmentAt(issue.path ?? [])}.filename is required and must be a string`,
				})
				.regex(FILENAME_PATTERN, {
					error: (issue) =>
						`${attachmentAt(issue.path ?? [])}.filename must not contain path separators`,
				}),
			content: z
				.string({
					error: (issue) =>
						`${attachmentAt(issue.path ?? [])}.content must be a base64-encoded string`,
				})
				.optional(),
			url: z
				.string({
					error: (issue) => `${attachmentAt(issue.path ?? [])}.url must be an HTTPS URL`,
				})
				.optional(),
			contentType: z
				.string({
					error: (issue) => `${attachmentAt(issue.path ?? [])}.contentType must be a string`,
				})
				.optional(),
		},
		{ error: (issue) => `${attachmentAt(issue.path ?? [])} must be an object` }
	)
	.refine((attachment) => (attachment.content === undefined) !== (attachment.url === undefined), {
		error: (issue) =>
			`${attachmentAt(issue.path ?? [])} must have exactly one of "content" (base64) or "url"`,
	})
	.meta({ oneOf: [{ required: ['content'] }, { required: ['url'] }] });

/**
 * `transactionalId` and `slug` may each be `null` or empty when the other one
 * names the template; the ID wins when both do.
 */
export const sendTransactionalRequestSchema = requestBody({
	email: requiredString('email is required', 'email must be a string'),
	transactionalId: z.string({ error: 'transactionalId must be a string' }).nullish(),
	slug: z.string({ error: 'slug must be a string' }).nullish(),
	dataVariables: jsonPrimitiveRecordSchema(
		'dataVariables must be an object of string, number, boolean or null values'
	).optional(),
	language: z
		.string({ error: 'language must be a string' })
		.regex(LANGUAGE_PATTERN, {
			error: "language must be a valid language code (e.g., 'en', 'de', 'fr', 'en-US')",
		})
		.optional(),
	attachments: z
		.array(transactionalAttachmentSchema, { error: 'attachments must be an array' })
		.max(ATTACHMENT_COMPOSE_LIMITS.maxCount, {
			error: `Maximum ${ATTACHMENT_COMPOSE_LIMITS.maxCount} attachments allowed`,
		})
		.optional(),
})
	.refine((body) => !!body.transactionalId || !!body.slug, {
		error: 'Either transactionalId or slug is required',
	})
	.meta(anyNonemptyReference('transactionalId', 'slug'));

export const sendTransactionalResponseSchema = z.strictObject({
	status: z.literal('queued'),
	email: z.string(),
	transactionalEmailId: z.string().meta({
		description:
			'ID of the send record created for this email, not the template ID. Delivery webhooks carry it.',
	}),
	slug: z.string(),
	contactId: z.string().optional(),
	contactCreated: z.boolean(),
	language: z.string(),
});
