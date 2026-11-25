import type { ListQuery } from '@owlat/public-contract';

export type {
	ContentIssue,
	ContentIssueSeverity,
	CreateTransactionalEmailRequest,
	EmailBlock,
	EmailBlockInput,
	EmailHealth,
	EmailHealthRecommendation,
	EmailHtmlAnalysis,
	EmailTranslation,
	EmailTranslationInput,
	PutTransactionalEmailRequest,
	RenderKind,
	RenderRequest,
	RenderResult,
	SavedBlock,
	SavedBlockInput,
	SavedBlockSummary,
	SavedBlockWriteResult,
	TemplateVariableType,
	TemplateWriteRefusalReason,
	RenderRefusalReason,
	TransactionalEmail,
	TransactionalEmailInput,
	TransactionalEmailStatus,
	TransactionalEmailSummary,
	TransactionalEmailWriteResult,
	TranslatedBlockText,
} from '@owlat/public-contract';

/** Page size and cursor for listing transactional emails or saved blocks. */
export type ListTemplatesParams = Omit<ListQuery, 'search'>;

/** Options of a write to a transactional email. */
export interface TransactionalEmailWriteOptions {
	/**
	 * The `revision` of the email the write was built on, from a read. The
	 * server refuses the write with a `ConflictError` (reason
	 * `revision_mismatch`) when the email changed since, for example in the
	 * editor.
	 */
	ifRevision?: number;
	/**
	 * Change a published email in place. The change goes live at once, after
	 * the content scan. Without it a published email is refused with an
	 * `InvalidStateError` (reason `email_published`).
	 */
	whilePublished?: boolean;
}
