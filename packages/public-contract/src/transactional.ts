/**
 * Transactional sends: `POST /api/v1/transactional`.
 *
 * The schemas check shape only. Email syntax, the envelope byte budget, URL
 * safety, base64 decoding and the decoded-size budget stay with the server,
 * which applies them after decoding and before any attachment byte is stored.
 */

import { z } from 'zod';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { MAX_REPEAT_ITEMS } from '@owlat/shared/sendRegions';
import { anyNonemptyReference, jsonPrimitiveSchema, requestBody, requiredString } from './common';
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

const DATA_VARIABLES_SHAPE =
	'dataVariables must be an object of string, number, boolean or null values, or of lists of them or of objects of them';

/**
 * The request's data variables. A list feeds a repeated Block: each entry is a
 * primitive or a flat object of primitives, and the list is capped at the
 * entries one repeated Block renders.
 */
export const transactionalDataVariablesSchema = z
	.record(
		z.string(),
		z.union(
			[
				jsonPrimitiveSchema,
				z
					.array(
						z.union([jsonPrimitiveSchema, z.record(z.string(), jsonPrimitiveSchema)], {
							error: DATA_VARIABLES_SHAPE,
						}),
						{ error: DATA_VARIABLES_SHAPE }
					)
					.meta({ maxItems: MAX_REPEAT_ITEMS }),
			],
			{ error: DATA_VARIABLES_SHAPE }
		),
		{ error: DATA_VARIABLES_SHAPE }
	)
	.check((ctx) => {
		// Checked here rather than with `.max()` on the list: a failed branch of
		// the union reports only the union's message, which would hide the limit.
		for (const [name, value] of Object.entries(ctx.value)) {
			if (Array.isArray(value) && value.length > MAX_REPEAT_ITEMS) {
				ctx.issues.push({
					code: 'custom',
					input: value,
					path: [name],
					message: `dataVariables.${name} can hold at most ${MAX_REPEAT_ITEMS} entries`,
				});
			}
		}
	});

/**
 * `transactionalId` and `slug` may each be `null` or empty when the other one
 * names the template; the ID wins when both do.
 */
export const sendTransactionalRequestSchema = requestBody({
	email: requiredString('email is required', 'email must be a string'),
	transactionalId: z.string({ error: 'transactionalId must be a string' }).nullish(),
	slug: z.string({ error: 'slug must be a string' }).nullish(),
	dataVariables: transactionalDataVariablesSchema.optional(),
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
	dryRun: z.boolean({ error: 'dryRun must be a boolean' }).optional().meta({
		description:
			'true composes the email and answers what a send would, with a 200 instead of the 202 of a send: nothing is sent, stored or counted. An instance older than this field ignores it and sends the email.',
	}),
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
	bounceCause: z.enum(['recipient', 'sender']).nullable().meta({
		description:
			'Who a bounce was about, as the email.bounced webhook names it: recipient (the address was refused) or sender (the receiver refused the sending IP or domain; the address is not blocklisted). Null without a bounce, and for a bounce recorded before servers stored the cause.',
	}),
	errorCode: z.string().nullable().meta({
		description: 'Stable code of the failure, for example MTA_UNREACHABLE. Null unless failed.',
	}),
	errorMessage: z.string().nullable().meta({
		description:
			"Why it did not arrive: the reason of the failure when failed, the receiving server's diagnostic text when bounced (null if the report carried none). Null otherwise.",
	}),
});
