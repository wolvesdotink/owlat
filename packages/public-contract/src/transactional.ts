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
import { TRANSACTIONAL_SEND_STATUSES } from './types';

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
			'ID of the send created for this email, not the template ID. Every email.* webhook for this send carries it as sendId, and GET /api/v1/transactional/{sendId} reads its status.',
	}),
	slug: z.string().meta({
		description: 'Slug of the template used, also when the request named it by ID.',
	}),
	contactId: z.string().optional(),
	contactCreated: z.boolean(),
	language: z.string(),
});

const timestamp = (step: string) =>
	z
		.string()
		.nullable()
		.meta({ description: `ISO 8601 timestamp of when the send ${step}; null until then.` });

export const transactionalSendStatusSchema = z.strictObject({
	sendId: z.string().meta({
		description: 'The ID the send call answered with as transactionalEmailId.',
	}),
	status: z.enum(TRANSACTIONAL_SEND_STATUSES),
	email: z.string(),
	templateId: z.string().nullable(),
	slug: z.string().nullable(),
	language: z.string().nullable(),
	queuedAt: timestamp('was queued'),
	sentAt: timestamp('was handed to the provider'),
	deliveredAt: timestamp('was accepted by the receiving server'),
	openedAt: timestamp('was first opened'),
	clickedAt: timestamp('had its first link clicked'),
	bouncedAt: timestamp('bounced'),
	complainedAt: timestamp('drew a spam complaint'),
	failedAt: timestamp('failed for good'),
	bounceType: z.enum(['hard', 'soft']).nullable(),
	errorCode: z.string().nullable().meta({
		description: 'Stable code of the failure, for example MTA_UNREACHABLE. Null unless failed.',
	}),
	errorMessage: z.string().nullable().meta({
		description: 'Human-readable reason of the failure. Null unless failed.',
	}),
});
