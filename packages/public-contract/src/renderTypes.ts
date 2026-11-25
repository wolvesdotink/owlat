/**
 * The wire types of `POST /api/v1/render` and of the dry run of a send,
 * `POST /api/v1/transactional/dry-run`. Plain TypeScript with type-only imports from
 * this folder, re-exported by `types.ts`; see there for why.
 */

import type {
	ContentIssue,
	EmailBlockInput,
	EmailTranslationInput,
	TemplateVariableType,
	TransactionalEmailStatus,
} from './templateTypes';
import type { DataVariableValue } from './types';

/** What a render renders as. */
export const RENDER_KINDS = ['transactional', 'template'] as const;

/** What a render renders as. */
export type RenderKind = (typeof RENDER_KINDS)[number];

/** `POST /api/v1/render`: block content to render without storing it. */
export interface RenderRequest {
	/**
	 * `transactional` (the default): variables are data variables, and
	 * conditions and repeats are resolved per send. `template`: a marketing
	 * template, whose variables are contact fields.
	 */
	kind?: RenderKind;
	subject?: string;
	/** The inbox preview line, rendered as the hidden preheader. */
	previewText?: string;
	blocks: EmailBlockInput[];
	translations?: Record<string, EmailTranslationInput>;
	/** Defaults to `en`. */
	defaultLanguage?: string;
	/** The language to answer with; defaults to the default language. */
	language?: string;
	dataVariablesSchema?: Record<string, TemplateVariableType>;
	/**
	 * Sample data for a transactional email: the answer is then the email a
	 * send with this data composes.
	 */
	dataVariables?: Record<string, DataVariableValue>;
	/** `true` also answers `darkHtml`. */
	darkMode?: boolean;
}

/** The error a send would answer with, as its error body carries it. */
export interface SendRefusal {
	/** The HTTP status the send would answer with. */
	status: number;
	category: string;
	message: string;
	/** The send's `error.data`: `reason`, and for `invalid_variables` `field` and `variables`. */
	data: Record<string, unknown>;
	/** Seconds a send would be told to wait, on a cap; otherwise `null`. */
	retryAfter: number | null;
}

/** One reason a health score is lower than it could be. */
export interface EmailHealthRecommendation {
	category: 'compatibility' | 'accessibility' | 'deliverability' | 'outlook';
	message: string;
	impact: 'high' | 'medium' | 'low';
}

/** What the health scores read from the rendered HTML. */
export interface EmailHtmlAnalysis {
	htmlSizeBytes: number;
	/** Over the size after which Gmail hides the rest of the body. */
	exceedsGmailClip: boolean;
	/** Over the style size past which Gmail drops the styles. */
	exceedsGmailCssLimit: boolean;
	styleBlockSizeBytes: number;
	tableNestingDepth: number;
	imageCount: number;
	linkCount: number;
	hasTextContent: boolean;
	/** Characters of text per image; `null` when there is text and no image. */
	textToImageRatio: number | null;
	/** Hidden elements beyond the preheader. */
	displayNoneCount: number;
	warnings: string[];
}

/** Scores from 0 to 100, higher is better. */
export interface EmailHealth {
	/** Weighted: compatibility 35%, deliverability 30%, accessibility 20%, Outlook 15%. */
	overall: number;
	/** Support of the top-level blocks across the known mail clients, per block. */
	compatibility: number;
	/** 100 less 20 per accessibility error and 10 per warning. */
	accessibility: number;
	/** 100 less deductions for size, missing text, images, hidden elements, links and CSS size. */
	deliverability: number;
	/** Support of the top-level blocks in the Outlook clients. */
	outlookSupport: number;
	recommendations: EmailHealthRecommendation[];
	analysis: EmailHtmlAnalysis;
}

/** What `POST /api/v1/render` answers. */
export interface RenderResult {
	kind: RenderKind;
	/** The language of the answer, after the fallback. */
	language: string;
	/**
	 * `true` when `dataVariables` were given and the answer is the composed
	 * email; `false` when it is what a save stores.
	 */
	composed: boolean;
	subject: string;
	html: string;
	/** `null` for a translation that is not composed: a translation stores no text body. */
	text: string | null;
	/** With `darkMode`, the HTML as a client in dark mode shows it; otherwise `null`. */
	darkHtml: string | null;
	/** What the content check of a write finds: warnings and notes. */
	issues: ContentIssue[];
	/** Data variables used without a fallback that `dataVariables` leaves out. */
	missingVariables: string[];
	/** When composed: the refusal a send with this data would meet, or `null`. */
	sendRefusal: SendRefusal | null;
	health: EmailHealth;
}

/** What `POST /api/v1/transactional/dry-run` answers. Nothing was sent. */
export interface SendTransactionalDryRun {
	status: 'dry_run';
	dryRun: true;
	/** Whether a send of this request would be queued now. */
	wouldQueue: boolean;
	/** The first refusal a send would meet now, or `null`. */
	refusal: SendRefusal | null;
	email: string;
	/** The transactional email, not a send. */
	templateId: string;
	slug: string;
	templateStatus: TransactionalEmailStatus;
	/** The recipient's existing contact when a send would be queued; otherwise `null`. */
	contactId: string | null;
	language: string;
	subject: string;
	/** The HTML a send would deliver, without the unsubscribe footer delivery appends. */
	html: string;
	text: string;
	/** `true` when delivery appends the unsubscribe footer, which the dry run leaves out. */
	unsubscribeFooter: boolean;
	/** Data variables the email uses without a fallback that `dataVariables` leaves out. */
	missingVariables: string[];
}
