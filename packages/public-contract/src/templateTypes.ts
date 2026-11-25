/**
 * Transactional emails and saved blocks: `/api/v1/transactional-emails` and
 * `/api/v1/saved-blocks`. Plain TypeScript with no imports, re-exported by
 * `types.ts`; see there for why.
 *
 * Every object here may gain fields in a later release. A client reads the
 * fields it knows and ignores the rest.
 */

/** Where a transactional email stands. */
export const TRANSACTIONAL_EMAIL_STATUSES = ['draft', 'pending_review', 'published'] as const;

/**
 * `draft` cannot be sent; `published` can; `pending_review` was held by the
 * content scan and goes live once an admin approves it.
 */
export type TransactionalEmailStatus = (typeof TRANSACTIONAL_EMAIL_STATUSES)[number];

/** The variable types a write may declare in `dataVariablesSchema`. */
export const TEMPLATE_VARIABLE_TYPES = ['string', 'number', 'boolean', 'date', 'array'] as const;

/** A variable type a write may declare. */
export type TemplateVariableType = (typeof TEMPLATE_VARIABLE_TYPES)[number];

/**
 * A variable's example value: a string (also for `date`, as an ISO date), a
 * number, a boolean, or for `array` a list of plain values or flat objects of
 * them.
 */
export type DataVariableExample =
	| string
	| number
	| boolean
	| Array<string | number | boolean | null | Record<string, string | number | boolean | null>>;

/**
 * One block of email content, exactly as the editor stores it: an `id`, a
 * `type` such as `text`, `button` or `columns`, and the block's `content`.
 * Blocks such as `columns` and `container` hold further blocks inside their
 * `content`. A block linked to a saved block carries a `savedBlockRef`.
 */
export interface EmailBlock {
	id: string;
	type: string;
	content: Record<string, unknown>;
	[key: string]: unknown;
}

/** A block in a write. Without an `id`, the server gives it one. */
export interface EmailBlockInput {
	id?: string;
	type: string;
	content: Record<string, unknown>;
	[key: string]: unknown;
}

/** The translated text of one block, keyed in a translation by the block's `id`. */
export interface TranslatedBlockText {
	/** A text block's HTML. */
	html?: string;
	/** A button's label. */
	buttonText?: string;
	/** An image's alt text. */
	alt?: string;
}

/**
 * One language of an email: its subject and the translated text of each
 * block. The layout comes from the default-language blocks; a block without
 * an entry keeps its default text.
 */
export interface EmailTranslation {
	/** The subject in this language, or `null` to use the default subject. */
	subject: string | null;
	blocks: Record<string, TranslatedBlockText>;
}

/** A translation in a write. */
export interface EmailTranslationInput {
	subject?: string | null;
	blocks?: Record<string, TranslatedBlockText>;
}

/** A transactional email in a list: everything but its content. */
export interface TransactionalEmailSummary {
	/** The email's ID, which a send may name as `transactionalId`. */
	id: string;
	/** The email's slug, which a send names and the routes here take. */
	slug: string;
	name: string;
	status: TransactionalEmailStatus;
	/** The default-language subject. */
	subject: string;
	/** The language of `subject` and `blocks`. */
	defaultLanguage: string;
	/** Every language the email can be sent in, the default language first. */
	languages: string[];
	/**
	 * The content revision. Every write to the name, subject, blocks or
	 * translations advances it. Send it back as `If-Match` to refuse a write
	 * when someone changed the email after you read it.
	 */
	revision: number;
	/** ISO 8601 timestamp of the last publish, or `null` while not published. */
	publishedAt: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

/**
 * A transactional email with its content. A `PUT` to its slug accepts this
 * object as it is, so a read is an export and a `PUT` of it an import.
 */
export interface TransactionalEmail extends TransactionalEmailSummary {
	blocks: EmailBlock[];
	/** The other languages, keyed by language code. */
	translations: Record<string, EmailTranslation>;
	/**
	 * The data variables a send passes, by name, with their type: `string`,
	 * `number`, `boolean`, `date` or `array`. Later releases may add types.
	 */
	dataVariablesSchema: Record<string, TemplateVariableType>;
	/**
	 * Sample data per variable for the editor preview and test sends, never
	 * used by a real send. Empty when the email has none.
	 */
	dataVariableExamples: Record<string, DataVariableExample>;
	/** Whether the email shows an unsubscribe link. */
	showUnsubscribe: boolean;
}

/**
 * The editable fields of a transactional email. A write replaces all of
 * them: a field left out takes its default (no variables, no translations,
 * `en`, no unsubscribe link). Fields the API does not carry (sender,
 * attachments, the text/plain override) keep their value.
 */
export interface TransactionalEmailInput {
	name: string;
	/** The default-language subject. Defaults to empty. */
	subject?: string;
	blocks: EmailBlockInput[];
	translations?: Record<string, EmailTranslationInput>;
	dataVariablesSchema?: Record<string, TemplateVariableType>;
	/**
	 * Sample data per variable, each matching the variable's type. Left out,
	 * each stored example stays while it still matches its variable's type;
	 * `{}` clears them.
	 */
	dataVariableExamples?: Record<string, DataVariableExample>;
	/** Defaults to `en`. Cannot change while the email has translations. */
	defaultLanguage?: string;
	showUnsubscribe?: boolean;
}

/** `POST /api/v1/transactional-emails`. */
export interface CreateTransactionalEmailRequest extends TransactionalEmailInput {
	/** Lowercase letters, digits and hyphens, unique among the transactional emails. */
	slug: string;
}

/** `PUT /api/v1/transactional-emails/{slug}`. */
export interface PutTransactionalEmailRequest extends TransactionalEmailInput {
	/** Optional; when given it must be the slug in the path. */
	slug?: string;
}

/** How serious a content issue is. Only `error` refuses a write. */
export const CONTENT_ISSUE_SEVERITIES = ['error', 'warning', 'info'] as const;

/** How serious a content issue is. */
export type ContentIssueSeverity = (typeof CONTENT_ISSUE_SEVERITIES)[number];

/**
 * Something the content check found in the blocks: a broken or risky block, or
 * a warning the renderer raised. New codes can be added.
 */
export interface ContentIssue {
	severity: ContentIssueSeverity;
	/** A stable code such as `BUTTON_NO_URL`, or `RENDER_WARNING`. */
	code: string;
	message: string;
	/** The block at fault, or `null` when the issue is about the whole email. */
	blockId: string | null;
	blockType: string | null;
}

/** What a create or update of a transactional email answers. */
export interface TransactionalEmailWriteResult {
	email: TransactionalEmail;
	/** Warnings and notes about the stored content. Errors refuse the write instead. */
	issues: ContentIssue[];
}

/** A saved block in a list: everything but its content. */
export interface SavedBlockSummary {
	id: string;
	name: string;
	/** What the block is for, or `null`. */
	description: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

/**
 * A saved block with its content: one or more blocks that emails link to.
 * Changing them changes every email that links the saved block.
 */
export interface SavedBlock extends SavedBlockSummary {
	blocks: EmailBlock[];
}

/** `POST /api/v1/saved-blocks` and `PUT /api/v1/saved-blocks/{id}`. A write replaces every field. */
export interface SavedBlockInput {
	name: string;
	/** Left out or `null` removes the description. */
	description?: string | null;
	blocks: EmailBlockInput[];
}

/** What a create or update of a saved block answers. */
export interface SavedBlockWriteResult {
	block: SavedBlock;
	issues: ContentIssue[];
}
