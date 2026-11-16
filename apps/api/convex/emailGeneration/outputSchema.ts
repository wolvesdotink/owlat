/**
 * What the model writes when it drafts an email: a small, closed outline, not
 * editor blocks. `blocksDecision.ts` turns it into `EditorBlock[]`, so the
 * model can never produce a block type, a style or an image URL the mapper
 * does not build itself.
 *
 * Every field is present and nullable rather than optional: several providers'
 * structured-output modes require every property to be listed. The caps below
 * are enforced by the mapper, not the schema, because not every provider
 * accepts `maxItems` / `maxLength`; a draft over a cap is cut, not refused.
 */

import { z } from 'zod';

/** The section kinds a generated email is built from. */
export const SECTION_KINDS = [
	'heading',
	'paragraph',
	'button',
	'list',
	'divider',
	'spacer',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** The data-variable types a transactional email declares (`dataVariablesSchema`). */
export const VARIABLE_TYPES = ['string', 'number', 'boolean', 'date'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const GENERATION_LIMITS = {
	/** The user's own description of the email. */
	promptChars: 2_000,
	sections: 40,
	nameChars: 120,
	subjectChars: 200,
	previewTextChars: 200,
	headingChars: 200,
	paragraphChars: 2_000,
	buttonLabelChars: 80,
	listItems: 12,
	listItemChars: 300,
	variables: 30,
	slugChars: 80,
	/** Picked references per request. */
	references: 3,
	/** Style samples read from the organisation's own emails. */
	samples: 3,
} as const;

const sectionSchema = z.object({
	kind: z.enum(SECTION_KINDS),
	text: z
		.string()
		.nullable()
		.describe(
			'heading and paragraph: the text; button: its label. Paragraphs may use **bold**, *italic* and [label](https://link). Null for list, divider and spacer.'
		),
	level: z
		.enum(['h1', 'h2', 'h3'])
		.nullable()
		.describe('heading only: h1 for the main title, h2/h3 below it. Null otherwise.'),
	url: z
		.string()
		.nullable()
		.describe('button only: the full https:// address or a {{variable}}. Null otherwise.'),
	items: z
		.array(z.string())
		.nullable()
		.describe('list only: one entry per bullet, same inline formatting as paragraphs.'),
	ordered: z.boolean().nullable().describe('list only: true for a numbered list.'),
});

const variableSchema = z.object({
	name: z.string().describe('camelCase name used as {{name}} in the content'),
	type: z.enum(VARIABLE_TYPES),
	optional: z.boolean().describe('true when a sender may leave it out'),
});

export const generatedEmailSchema = z.object({
	name: z.string().describe('Short internal name for the email, e.g. "Booking confirmation"'),
	subject: z.string(),
	previewText: z.string().describe('The inbox preview line shown after the subject'),
	language: z.string().describe('ISO 639-1 code of the language the email is written in'),
	slug: z
		.string()
		.nullable()
		.describe('transactional only: lowercase-with-hyphens API identifier. Null otherwise.'),
	sections: z.array(sectionSchema),
	variables: z
		.array(variableSchema)
		.describe('transactional only: every {{variable}} the content uses. Empty otherwise.'),
});

export type GeneratedEmail = z.infer<typeof generatedEmailSchema>;
export type GeneratedSection = GeneratedEmail['sections'][number];
export type GeneratedVariable = GeneratedEmail['variables'][number];
