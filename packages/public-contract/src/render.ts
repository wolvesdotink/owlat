/**
 * Rendering without storing: `POST /api/v1/render`, and the dry run of
 * `POST /api/v1/transactional`.
 *
 * The schemas check shape only. The blocks get the content check of a
 * template write, and the variables the checks of a send, on the server.
 */

import { z } from 'zod';
import { requestBody } from './common';
import { contentIssueSchema, languageCode, transactionalEmailInputShape } from './templates';
import { transactionalDataVariablesSchema } from './transactional';
import { RENDER_KINDS, TRANSACTIONAL_EMAIL_STATUSES } from './types';

/** Longest preview text a render accepts. */
export const PREVIEW_TEXT_MAX_LENGTH = 500;

export const renderRequestSchema = requestBody({
	kind: z
		.enum(RENDER_KINDS, { error: `kind must be one of ${RENDER_KINDS.join(', ')}` })
		.optional()
		.meta({
			description:
				'transactional (the default) renders as a transactional email: variables are data variables, and conditions and repeats are resolved per send. template renders as a marketing template, whose variables are contact fields and whose conditions are decided on save.',
		}),
	subject: transactionalEmailInputShape.subject,
	previewText: z
		.string({ error: 'previewText must be a string' })
		.max(PREVIEW_TEXT_MAX_LENGTH, {
			error: `previewText must be at most ${PREVIEW_TEXT_MAX_LENGTH} characters`,
		})
		.optional()
		.meta({ description: 'The inbox preview line, rendered as the hidden preheader.' }),
	blocks: transactionalEmailInputShape.blocks,
	translations: transactionalEmailInputShape.translations,
	defaultLanguage: transactionalEmailInputShape.defaultLanguage,
	language: languageCode('language must be a language code such as en').optional().meta({
		description:
			'The language to answer with. Defaults to the default language; a language without a translation falls back to it, as a send does.',
	}),
	dataVariablesSchema: transactionalEmailInputShape.dataVariablesSchema,
	dataVariables: transactionalDataVariablesSchema.optional().meta({
		description:
			'Sample data for a transactional email. With it the email is composed as a send composes it: conditions and repeats resolved, variables filled, and the refusal a send with this data would meet in sendRefusal.',
	}),
	darkMode: z.boolean({ error: 'darkMode must be a boolean' }).optional().meta({
		description:
			"true also answers darkHtml. Mail clients apply an email's dark styles themselves, so html is the same either way.",
	}),
});

export const sendRefusalSchema = z
	.strictObject({
		status: z.number().int().meta({ description: 'The HTTP status the send would answer with.' }),
		category: z.string(),
		message: z.string(),
		data: z.record(z.string(), z.unknown()).meta({
			description: "The send's error.data: reason, and for invalid_variables field and variables.",
		}),
		retryAfter: z
			.number()
			.int()
			.nullable()
			.meta({ description: 'Seconds a send would be told to wait, on a cap; otherwise null.' }),
	})
	.meta({ description: 'The error a send would answer with, as its error body carries it.' });

const scoreMeta = (what: string) =>
	z
		.number()
		.int()
		.meta({ description: `0 to 100, higher is better: ${what}` });

export const emailHealthSchema = z.strictObject({
	overall: scoreMeta(
		'the weighted mean of the four scores below (compatibility 35%, deliverability 30%, accessibility 20%, Outlook 15%).'
	),
	compatibility: scoreMeta(
		'how well the top-level blocks are supported across the mail clients the renderer knows, averaged per block.'
	),
	accessibility: scoreMeta(
		'100 less 20 per accessibility error and 10 per warning (contrast, missing alt text, link text, heading order).'
	),
	deliverability: scoreMeta(
		"100 less deductions for a body past Gmail's clipping size, no text, a low text-to-image ratio, many hidden elements, over 60 links, or CSS past Gmail's limit."
	),
	outlookSupport: scoreMeta(
		'how well the top-level blocks are supported in the Outlook clients: full support counts 100, partial 70.'
	),
	recommendations: z.array(
		z.strictObject({
			category: z.enum(['compatibility', 'accessibility', 'deliverability', 'outlook']),
			message: z.string(),
			impact: z.enum(['high', 'medium', 'low']),
		})
	),
	analysis: z
		.strictObject({
			htmlSizeBytes: z.number().int(),
			exceedsGmailClip: z
				.boolean()
				.meta({ description: 'Over the size after which Gmail hides the rest of the body.' }),
			exceedsGmailCssLimit: z
				.boolean()
				.meta({ description: 'Over the style size past which Gmail drops the styles.' }),
			styleBlockSizeBytes: z.number().int(),
			tableNestingDepth: z.number().int(),
			imageCount: z.number().int(),
			linkCount: z.number().int(),
			hasTextContent: z.boolean(),
			textToImageRatio: z.number().nullable().meta({
				description: 'Characters of text per image; null when there is text and no image.',
			}),
			displayNoneCount: z.number().int().meta({
				description: 'Hidden elements beyond the preheader.',
			}),
			warnings: z.array(z.string()),
		})
		.meta({ description: 'What the scores read from the HTML of the answer.' }),
});

export const renderResultSchema = z.strictObject({
	kind: z.enum(RENDER_KINDS),
	language: z.string().meta({ description: 'The language of the answer, after the fallback.' }),
	composed: z.boolean().meta({
		description:
			'true when dataVariables were given and the answer is the composed email. false: subject, html and text are what a save stores, with every conditional and repeated block once and variables as written.',
	}),
	subject: z.string(),
	html: z.string(),
	text: z.string().nullable().meta({
		description:
			'The text/plain body. Null for a translation that is not composed: a translation stores no text body, and a send derives it from the HTML.',
	}),
	darkHtml: z.string().nullable().meta({
		description:
			"With darkMode: html with the email's own prefers-color-scheme: dark rules always applied, as a client in dark mode that honours them shows it. Clients that recolour an email by themselves are not modelled. Otherwise null.",
	}),
	issues: z.array(contentIssueSchema).meta({
		description:
			'What the content check of a write finds in these blocks: warnings and notes. An error refuses the render with invalid_content, as it refuses a write.',
	}),
	missingVariables: z.array(z.string()).meta({
		description:
			'Data variables the content uses without a fallback that dataVariables leaves out (all of them without dataVariables). Always empty for a template.',
	}),
	sendRefusal: sendRefusalSchema.nullable().meta({
		description:
			'When composed: the refusal a send with this data would meet from its variable checks (types, missing variables), or null.',
	}),
	health: emailHealthSchema,
});

export const sendTransactionalDryRunSchema = z.strictObject({
	status: z.literal('dry_run'),
	dryRun: z.literal(true),
	wouldQueue: z.boolean().meta({
		description: 'Whether a send of this request would be queued now. false: see refusal.',
	}),
	refusal: sendRefusalSchema.nullable().meta({
		description: 'The first refusal a send of this request would meet now, or null.',
	}),
	email: z.string(),
	templateId: z.string().meta({ description: 'The transactional email, not a send.' }),
	slug: z.string(),
	templateStatus: z.enum(TRANSACTIONAL_EMAIL_STATUSES),
	contactId: z.string().nullable().meta({
		description:
			"The recipient's existing contact when a send would be queued; null when it would be refused, or would create the contact.",
	}),
	language: z.string(),
	subject: z.string(),
	html: z.string().meta({
		description:
			'The HTML a send would deliver, without the unsubscribe footer that delivery appends (see unsubscribeFooter).',
	}),
	text: z.string(),
	unsubscribeFooter: z.boolean().meta({
		description:
			'true when delivery appends the unsubscribe footer to the HTML and text, which the dry run leaves out.',
	}),
	missingVariables: z.array(z.string()).meta({
		description: 'Data variables the email uses without a fallback that dataVariables leaves out.',
	}),
});
