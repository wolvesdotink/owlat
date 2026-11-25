/**
 * Transactional emails (`/api/v1/transactional-emails`) and saved blocks
 * (`/api/v1/saved-blocks`).
 *
 * The schemas check shape only. The slug format, the block content itself
 * (`validateBlocks` from the email renderer) and the stored size are the
 * server's own checks, applied after decoding.
 */

import { z } from 'zod';
import { requestBody, requiredString } from './common';
import {
	CONTENT_ISSUE_SEVERITIES,
	TEMPLATE_VARIABLE_TYPES,
	TRANSACTIONAL_EMAIL_STATUSES,
} from './types';

/** Longest name a write accepts. */
export const TEMPLATE_NAME_MAX_LENGTH = 200;

/** Longest subject a write accepts. */
export const TEMPLATE_SUBJECT_MAX_LENGTH = 500;

/** Longest saved-block description a write accepts. */
export const SAVED_BLOCK_DESCRIPTION_MAX_LENGTH = 1000;

/** A data variable name: a letter, then letters, digits and underscores. */
export const TEMPLATE_VARIABLE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** A language code such as `de` or `pt-BR`. */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const blockMeta = {
	description:
		'One block as the editor stores it: an id, a type and the content of that type. Blocks such as columns and container hold further blocks inside their content.',
};

export const emailBlockSchema = z
	.looseObject({
		id: z.string(),
		type: z.string(),
		content: z.record(z.string(), z.unknown()),
	})
	.meta(blockMeta);

const emailBlockInputSchema = z
	.looseObject(
		{
			id: z.string({ error: 'A block id must be a string' }).optional(),
			type: z.string({ error: 'A block needs a type' }),
			content: z.record(z.string(), z.unknown(), { error: 'A block needs a content object' }),
		},
		{ error: 'Each block must be an object' }
	)
	.meta(blockMeta);

const blocksInputSchema = z.array(emailBlockInputSchema, { error: 'blocks must be an array' });

const translatedBlockTextShape = {
	html: z.string({ error: 'html must be a string' }).optional(),
	buttonText: z.string({ error: 'buttonText must be a string' }).optional(),
	alt: z.string({ error: 'alt must be a string' }).optional(),
};

export const translatedBlockTextSchema = z.strictObject(translatedBlockTextShape);

export const emailTranslationSchema = z.strictObject({
	subject: z
		.string()
		.nullable()
		.meta({ description: 'The subject in this language, or null to use the default subject.' }),
	blocks: z.record(z.string(), translatedBlockTextSchema).meta({
		description: "Each block's translated text, keyed by the block's id.",
	}),
});

const emailTranslationInputSchema = z.object(
	{
		subject: z.string({ error: 'A translation subject must be a string' }).nullish(),
		blocks: z
			.record(
				z.string(),
				z.object(translatedBlockTextShape, {
					error: 'Each translated block must be an object of html, buttonText and alt',
				}),
				{ error: 'A translation needs a blocks object' }
			)
			.optional(),
	},
	{ error: 'Each translation must be an object' }
);

const languageCode = (message: string) =>
	z.string({ error: message }).regex(LANGUAGE_CODE_PATTERN, { error: message });

const transactionalEmailInputShape = {
	name: requiredString('name is required', 'name must be a string').max(TEMPLATE_NAME_MAX_LENGTH, {
		error: `name must be at most ${TEMPLATE_NAME_MAX_LENGTH} characters`,
	}),
	subject: z
		.string({ error: 'subject must be a string' })
		.max(TEMPLATE_SUBJECT_MAX_LENGTH, {
			error: `subject must be at most ${TEMPLATE_SUBJECT_MAX_LENGTH} characters`,
		})
		.optional(),
	blocks: blocksInputSchema,
	translations: z
		.record(
			languageCode('A translation must be keyed by a language code'),
			emailTranslationInputSchema,
			{
				error: 'translations must be an object keyed by language code',
			}
		)
		.optional(),
	dataVariablesSchema: z
		.record(
			z.string().regex(TEMPLATE_VARIABLE_NAME_PATTERN, {
				error:
					'A variable name must start with a letter and hold only letters, digits and underscores',
			}),
			z.enum(TEMPLATE_VARIABLE_TYPES, {
				error: `A variable type must be one of ${TEMPLATE_VARIABLE_TYPES.join(', ')}`,
			}),
			{ error: 'dataVariablesSchema must be an object of variable names and types' }
		)
		.optional(),
	defaultLanguage: languageCode('defaultLanguage must be a language code such as en').optional(),
	showUnsubscribe: z.boolean({ error: 'showUnsubscribe must be a boolean' }).optional(),
};

export const createTransactionalEmailRequestSchema = requestBody({
	slug: requiredString('slug is required', 'slug must be a string'),
	...transactionalEmailInputShape,
});

export const putTransactionalEmailRequestSchema = requestBody({
	slug: z.string({ error: 'slug must be a string' }).optional(),
	...transactionalEmailInputShape,
});

const isoTimestamp = z.string().meta({ description: 'ISO 8601 timestamp.' });

const transactionalEmailSummaryShape = {
	id: z.string().meta({ description: 'The ID a send may name as transactionalId.' }),
	slug: z.string(),
	name: z.string(),
	status: z.enum(TRANSACTIONAL_EMAIL_STATUSES).meta({
		description:
			'draft cannot be sent; published can; pending_review was held by the content scan and goes live once an admin approves it.',
	}),
	subject: z.string().meta({ description: 'The default-language subject.' }),
	defaultLanguage: z.string(),
	languages: z.array(z.string()).meta({
		description: 'Every language the email can be sent in, the default language first.',
	}),
	revision: z.number().int().meta({
		description:
			'The content revision, advanced by every write to the name, subject, blocks or translations. Send it as If-Match to refuse a write when the email changed after you read it.',
	}),
	publishedAt: z
		.string()
		.nullable()
		.meta({ description: 'ISO 8601 timestamp of the last publish, or null while not published.' }),
	createdAt: isoTimestamp,
	updatedAt: isoTimestamp,
};

export const transactionalEmailSummarySchema = z.strictObject(transactionalEmailSummaryShape);

export const transactionalEmailSchema = z.strictObject({
	...transactionalEmailSummaryShape,
	blocks: z.array(emailBlockSchema),
	translations: z
		.record(z.string(), emailTranslationSchema)
		.meta({ description: 'The other languages, keyed by language code.' }),
	dataVariablesSchema: z.record(z.string(), z.enum(TEMPLATE_VARIABLE_TYPES)).meta({
		description:
			'The data variables a send passes, by name, with their type: string, number, boolean or date. Later releases may add types.',
	}),
	showUnsubscribe: z.boolean(),
});

export const contentIssueSchema = z.strictObject({
	severity: z.enum(CONTENT_ISSUE_SEVERITIES),
	code: z.string().meta({
		description: 'A stable code such as BUTTON_NO_URL, or RENDER_WARNING. New codes can be added.',
	}),
	message: z.string(),
	blockId: z.string().nullable(),
	blockType: z.string().nullable(),
});

export const transactionalEmailWriteResultSchema = z.strictObject({
	email: transactionalEmailSchema,
	issues: z.array(contentIssueSchema).meta({
		description: 'Warnings and notes about the stored content. Errors refuse the write instead.',
	}),
});

const savedBlockSummaryShape = {
	id: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	createdAt: isoTimestamp,
	updatedAt: isoTimestamp,
};

export const savedBlockSummarySchema = z.strictObject(savedBlockSummaryShape);

export const savedBlockSchema = z.strictObject({
	...savedBlockSummaryShape,
	blocks: z.array(emailBlockSchema),
});

const savedBlockShape = {
	name: requiredString('name is required', 'name must be a string').max(TEMPLATE_NAME_MAX_LENGTH, {
		error: `name must be at most ${TEMPLATE_NAME_MAX_LENGTH} characters`,
	}),
	description: z
		.string({ error: 'description must be a string' })
		.max(SAVED_BLOCK_DESCRIPTION_MAX_LENGTH, {
			error: `description must be at most ${SAVED_BLOCK_DESCRIPTION_MAX_LENGTH} characters`,
		})
		.nullish(),
	blocks: blocksInputSchema,
};

export const savedBlockRequestSchema = requestBody(savedBlockShape);

/**
 * A replace cannot empty a saved block, as the editor cannot: the emails that
 * link it would lose their copy and nothing would be left to replace later.
 */
export const savedBlockUpdateRequestSchema = requestBody({
	...savedBlockShape,
	blocks: blocksInputSchema.min(1, { error: 'A saved block needs at least one block' }),
});

export const savedBlockWriteResultSchema = z.strictObject({
	block: savedBlockSchema,
	issues: z.array(contentIssueSchema),
});
