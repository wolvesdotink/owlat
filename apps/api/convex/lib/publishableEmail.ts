/**
 * Publishable email — the pieces `emailTemplates` and `transactionalEmails`
 * share. The two tables carry the same editor columns (blocks, rendered HTML,
 * text/plain body, translation overlays, saved-block links, render state), so
 * the rules for editing, publishing and duplicating them live here once and
 * each `emails.ts` keeps only its table-specific fields.
 *
 * Status transitions stay in each table's lifecycle module (ADR-0022); this
 * module only computes what those transitions and the editor `update`
 * mutations write.
 *
 * The rendered HTML is computed here, on the server, from the stored (and so
 * sanitized) blocks: the editor save, publish and the saved-block rerender all
 * call `renderPublishableEmail`. HTML a client sends is not stored.
 */

import { renderEmailHtml, renderPlainText } from '@owlat/email-renderer';
import type { EmailTheme } from '@owlat/shared';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { applyUsageCountDelta, parseContentBlocks } from '../emailBlocks/module';
import {
	mergeTranslationIntoItem,
	type BlockLikeItem,
	type TranslatableBlockContent,
} from '../emailTemplates/translationMerge';
import { CURRENT_CONTENT_BLOCK_VERSION, CURRENT_RENDERER_VERSION } from './constants';
import { nextContentRevision } from './contentRevision';
import { parseTranslations } from './emailTranslations';
import { buildSearchableText } from './queryHelpers';
import { sanitizeStoredBlocksJson, sanitizeTranslationsJson } from './emailContentSanitize';

export type PublishableEmailRow = Doc<'emailTemplates'> | Doc<'transactionalEmails'>;

// ─── Render ─────────────────────────────────────────────────────────────────

/** Templates personalize per contact; transactional emails interpolate data. */
export type PublishableEmailVariableType = 'personalization' | 'data';

/** The columns a render reads. */
export type RenderablePublishableEmail = {
	content: string;
	subject: string;
	translations?: string;
	supportedLanguages?: string[];
	defaultLanguage?: string;
	/** Author's hand-written text/plain body — never overwritten by a render. */
	plainTextOverride?: string;
};

export interface RenderedPublishableEmail {
	html: string;
	htmlTranslations: string | undefined;
	/** Regenerated text/plain body; absent when the author wrote their own. */
	plainTextContent: string | undefined;
}

/**
 * Overlay a language's translated text onto the default-language blocks. Falls
 * back to the unmerged blocks if the translation has no per-block map.
 */
function mergeTranslatedBlocks(
	defaultBlocks: BlockLikeItem[],
	translationBlocks: Record<string, TranslatableBlockContent> | undefined
): BlockLikeItem[] {
	if (!translationBlocks) return defaultBlocks;
	return defaultBlocks.map((block) => mergeTranslationIntoItem(block, translationBlocks));
}

/**
 * Render a publishable email row: the default-language body, then each
 * supported language's translated text overlaid onto the default block
 * structure, exactly as `getForLanguage` merges at save time. The two tables
 * differ only by `variableType`.
 *
 * Cost: one full render per language with an overlay, plus the default, and
 * every render walks every block. The editor save, publish and duplicate run
 * this inside a mutation, so a large template translated into many languages
 * spends that many renders of the mutation's execution budget. Measured on the
 * seed fixtures repeated to 200 blocks, one render took about 13 ms (Bun, warm
 * JIT; the Convex isolate is slower cold). There is no cap on
 * `supportedLanguages`; if very large multi-language templates start to time
 * out, cap the languages or move the translation renders to the rerender pool.
 */
export function renderPublishableEmail(
	row: RenderablePublishableEmail,
	variableType: PublishableEmailVariableType,
	theme: EmailTheme | undefined
): RenderedPublishableEmail {
	const blocks = parseContentBlocks(row.content);
	const html = renderEmailHtml(blocks as Parameters<typeof renderEmailHtml>[0], {
		variableType,
		theme,
	});
	// The text/plain body tracks the blocks exactly as the html does — EXCEPT
	// when the author wrote their own, which a render must not clobber.
	const plainTextContent = row.plainTextOverride?.trim()
		? undefined
		: renderPlainText(blocks as Parameters<typeof renderPlainText>[0]);

	let htmlTranslations: string | undefined;
	if (row.translations && row.supportedLanguages?.length) {
		const translationsObj: Record<string, { htmlContent: string; subject: string }> = {};
		try {
			const translations = JSON.parse(row.translations) as Record<
				string,
				{ subject?: string; blocks?: Record<string, TranslatableBlockContent> }
			>;

			for (const lang of row.supportedLanguages) {
				if (lang === row.defaultLanguage) continue;
				const langTranslation = translations[lang];
				if (!langTranslation) continue;

				const translatedBlocks = mergeTranslatedBlocks(
					blocks as BlockLikeItem[],
					langTranslation.blocks
				);
				translationsObj[lang] = {
					htmlContent: renderEmailHtml(
						translatedBlocks as unknown as Parameters<typeof renderEmailHtml>[0],
						{ variableType, theme }
					),
					subject: langTranslation.subject ?? row.subject,
				};
			}
		} catch {
			// Invalid translations JSON — skip; render still proceeds.
		}

		if (Object.keys(translationsObj).length > 0) {
			htmlTranslations = JSON.stringify(translationsObj);
		}
	}

	return { html, htmlTranslations, plainTextContent };
}

/**
 * `renderPublishableEmail` for a mutation: a row whose blocks the renderer
 * cannot handle is refused as invalid input instead of failing the write with
 * an internal error. The editor renders the same blocks with the same renderer
 * before it saves, so only a malformed API payload lands here.
 */
function renderForWrite(
	row: RenderablePublishableEmail,
	variableType: PublishableEmailVariableType,
	theme: EmailTheme | undefined
): RenderedPublishableEmail {
	try {
		return renderPublishableEmail(row, variableType, theme);
	} catch {
		throwInvalidInput('The email content could not be rendered.');
	}
}

/** The instance's email theme, which every render of a stored email uses. */
export async function loadEmailTheme(ctx: {
	db: MutationCtx['db'];
}): Promise<EmailTheme | undefined> {
	const settings = await ctx.db.query('instanceSettings').first();
	return settings?.emailTheme ?? undefined;
}

// ─── Publish invariant guard ────────────────────────────────────────────────

/**
 * Refuse to mutate publishable content on a `published` row unless the caller
 * passes `forceWhilePublished: true`. Consumed by every mutation that touches
 * publishable content on either table. `noun` names the row at the start of the
 * message ('Template', 'Transactional email').
 *
 * The editor surfaces an "Unpublish to edit?" gate on this error;
 * `data.action = 'unpublish'` is what it keys on.
 */
export function assertEditableForPublishableChange(
	row: { status: string },
	noun: string,
	force?: boolean
): void {
	if (row.status === 'published' && !force) {
		throwInvalidState(`${noun} is published. Pass forceWhilePublished: true or unpublish first.`, {
			action: 'unpublish',
		});
	}
}

// ─── Publish ────────────────────────────────────────────────────────────────

/**
 * The HTML a publish puts live: rendered here from the row's stored blocks and
 * translation overlays, in the same transaction as the status change.
 *
 * Neither client HTML nor the row's stored HTML is used. The editor sends the
 * HTML of the row it last saw, and a saved-block rerender can replace the
 * row's HTML without moving its content revision; and a row saved before the
 * server rendered on save may still hold HTML a client sent. Rendering from
 * the blocks covers both, and a row that was never rendered. A row whose HTML
 * is still behind its content (a rerender pending or failed) is refused, as
 * before, so what the editor shows as pending is not published under it.
 */
export function publishedHtml(
	row: Pick<PublishableEmailRow, 'htmlRenderState'> & RenderablePublishableEmail,
	render: { variableType: PublishableEmailVariableType; theme: EmailTheme | undefined }
): { htmlContent: string; htmlTranslations?: string } {
	if (row.htmlRenderState?.stale) {
		throwInvalidState(
			'A saved block this email uses changed and its HTML is still being updated, so it was not published. Try again in a moment.',
			{
				reason: 'html_render_pending',
				messageKey: 'dashboard.send.emails.detail.edit.toasts.htmlStillRendering',
			}
		);
	}
	const rendered = renderForWrite(row, render.variableType, render.theme);
	return { htmlContent: rendered.html, htmlTranslations: rendered.htmlTranslations };
}

// ─── Duplicate ──────────────────────────────────────────────────────────────

/**
 * Columns a copy never inherits: identity, publish state, timestamps,
 * per-row bookkeeping and the render state (the copy is rendered fresh).
 */
const NOT_DUPLICATED = [
	'_id',
	'_creationTime',
	'status',
	'publishedAt',
	'createdAt',
	'updatedAt',
	'searchableText',
	'contentRevision',
	'sendCount',
	'seedTag',
	'htmlRenderState',
] as const;

type NotDuplicated = (typeof NOT_DUPLICATED)[number];

/**
 * The columns a duplicate copies from its source: every column except the ones
 * in `NOT_DUPLICATED`, so a column added to either table is copied by default
 * instead of silently dropped.
 *
 * Text-block HTML in the copied content and translation overlays is sanitized,
 * as on every other content write, and the copy's HTML is rendered from that
 * sanitized content rather than copied: the source's stored HTML may be behind
 * its content (a pending saved-block rerender) or, on a row saved before the
 * server rendered on save, HTML a client sent.
 *
 * The caller sets the copy's name (and slug), `searchableText`,
 * `status: 'draft'`, `createdAt` and `updatedAt`.
 */
export function duplicateEmailFields<T extends PublishableEmailRow>(
	row: T,
	render: { variableType: PublishableEmailVariableType; theme: EmailTheme | undefined }
): Omit<T, NotDuplicated> {
	const copy: Record<string, unknown> = { ...row };
	for (const key of NOT_DUPLICATED) delete copy[key];
	const content = sanitizeStoredBlocksJson(row.content);
	const translations =
		row.translations === undefined ? undefined : sanitizeTranslationsJson(row.translations);
	copy['content'] = content;
	if (translations !== undefined) copy['translations'] = translations;
	try {
		const rendered = renderPublishableEmail(
			{ ...row, content, translations },
			render.variableType,
			render.theme
		);
		copy['htmlContent'] = rendered.html;
		copy['htmlTranslations'] = rendered.htmlTranslations;
	} catch {
		// Blocks the renderer cannot handle: the copy starts unrendered, like a
		// row created outside the editor, and its publish is refused until it
		// renders. The duplicate itself still succeeds.
		delete copy['htmlContent'];
		delete copy['htmlTranslations'];
	}
	copy['contentBlockVersion'] = row.contentBlockVersion ?? CURRENT_CONTENT_BLOCK_VERSION;
	copy['rendererVersion'] = row.rendererVersion ?? CURRENT_RENDERER_VERSION;
	return copy as Omit<T, NotDuplicated>;
}

// ─── Editor update ──────────────────────────────────────────────────────────

/** The editable fields both tables accept on `update`. */
export interface EditableEmailArgs {
	name?: string;
	subject?: string;
	content?: string;
	htmlContent?: string;
	// text/plain alternative shipped with the html. `plainTextContent` is the
	// effective body; `plainTextOverride` records the author's own text so the
	// editor can tell the two apart. An EMPTY `plainTextOverride` is the
	// editor's "revert to generated" signal and clears the column.
	plainTextContent?: string;
	plainTextOverride?: string;
	defaultLanguage?: string;
	supportedLanguages?: string[];
	translations?: string;
	htmlTranslations?: string;
	linkedBlockIds?: string[];
}

export interface EditableEmailPatch {
	name?: string;
	subject?: string;
	content?: string;
	htmlContent?: string;
	plainTextContent?: string;
	plainTextOverride?: string;
	defaultLanguage?: string;
	supportedLanguages?: string[];
	translations?: string;
	htmlTranslations?: string;
	linkedBlockIds?: string[];
	searchableText?: string;
	htmlRenderState?: { stale: boolean };
	contentRevision: number;
	updatedAt: number;
}

/**
 * The update arguments that change what the rendered HTML and text/plain body
 * are built from, or that carry client-rendered output the server replaces
 * with its own render. `subject` is one: each translation's HTML entry falls
 * back to the default subject.
 */
const RENDER_INPUTS = [
	'content',
	'subject',
	'htmlContent',
	'htmlTranslations',
	'plainTextContent',
	'plainTextOverride',
	'translations',
	'supportedLanguages',
	'defaultLanguage',
] as const satisfies ReadonlyArray<keyof EditableEmailArgs>;

/** The columns a table folds into `searchableText`, in order. */
type SearchableField = 'name' | 'subject' | 'slug';

/**
 * Build the patch for the editable fields both tables share, and keep the
 * saved-block usage counts in step with a changed `linkedBlockIds`.
 *
 * `searchableFields` lists the columns the table folds into `searchableText`;
 * the text is rebuilt when any of them is in `args` (a table-specific one such
 * as `slug` is read from `args` too, but patched by the caller).
 *
 * `defaultLanguage` is accepted for older clients but can only relabel a row
 * without translation overlays: with overlays, moving the label would leave
 * the old-language body under the new language, so that change has to go
 * through `setDefaultLanguage`, which swaps the body with the overlay.
 */
export async function buildEditablePatch(
	ctx: MutationCtx,
	row: PublishableEmailRow,
	args: EditableEmailArgs & { slug?: string },
	options: {
		noun: string;
		searchableFields: ReadonlyArray<SearchableField>;
		variableType: PublishableEmailVariableType;
	}
): Promise<EditableEmailPatch> {
	const patch: EditableEmailPatch = {
		contentRevision: nextContentRevision(row),
		updatedAt: Date.now(),
	};

	if (args.defaultLanguage !== undefined) {
		const relabels = args.defaultLanguage !== (row.defaultLanguage ?? 'en');
		if (
			relabels &&
			Object.keys(parseTranslations(args.translations ?? row.translations)).length > 0
		) {
			throwInvalidState(
				`This ${options.noun.toLowerCase()} has translations, so its default language cannot be changed by an update: the body would stay in the old language.`,
				{ reason: 'use_set_default_language' }
			);
		}
		patch.defaultLanguage = args.defaultLanguage;
	}

	if (args.name !== undefined) patch.name = args.name.trim();
	if (args.subject !== undefined) patch.subject = args.subject.trim();
	// Text-block HTML is sanitized on every write (lib/emailContentSanitize.ts).
	if (args.content !== undefined) patch.content = sanitizeStoredBlocksJson(args.content);

	if (args.plainTextOverride !== undefined) {
		// Patching a field to `undefined` REMOVES it, which is what "the author
		// cleared the override editor" has to mean; an empty string would keep
		// winning over the generated body forever.
		patch.plainTextOverride = args.plainTextOverride.trim() ? args.plainTextOverride : undefined;
	}

	if (args.supportedLanguages !== undefined) patch.supportedLanguages = args.supportedLanguages;
	if (args.translations !== undefined) {
		patch.translations = sanitizeTranslationsJson(args.translations);
	}

	// The HTML is rendered here from the blocks being stored, never taken from
	// the client: `htmlContent` / `htmlTranslations` in `args` only say that the
	// caller expects the HTML to follow this write. A write that changes what
	// the HTML is built from renders it too, so the stored HTML always matches
	// the stored (sanitized) content. The text/plain body follows the same
	// render unless the author's override is in effect; only then is the
	// client's `plainTextContent` (the override as the editor sends it) kept.
	if (RENDER_INPUTS.some((field) => args[field] !== undefined)) {
		const plainTextOverride =
			args.plainTextOverride !== undefined ? patch.plainTextOverride : row.plainTextOverride;
		const rendered = renderForWrite(
			{
				content: patch.content ?? row.content,
				subject: patch.subject ?? row.subject,
				translations: patch.translations ?? row.translations,
				supportedLanguages: patch.supportedLanguages ?? row.supportedLanguages,
				defaultLanguage: patch.defaultLanguage ?? row.defaultLanguage,
				plainTextOverride,
			},
			options.variableType,
			await loadEmailTheme(ctx)
		);
		patch.htmlContent = rendered.html;
		patch.htmlTranslations = rendered.htmlTranslations;
		if (rendered.plainTextContent !== undefined) {
			patch.plainTextContent = rendered.plainTextContent;
		} else if (args.plainTextContent !== undefined) {
			patch.plainTextContent = args.plainTextContent;
		}
		// The HTML matches the content again, so a saved-block rerender still
		// pending for the previous revision has nothing left to fix (it no-ops
		// on the moved row).
		if (row.htmlRenderState) patch.htmlRenderState = { stale: false };
	}

	if (args.linkedBlockIds !== undefined) {
		patch.linkedBlockIds = args.linkedBlockIds;
		// A normal editor save patches the row directly (it does NOT route
		// through the lifecycle's create/duplicate effect), so keep saved-block
		// usageCount in sync here by diffing the previous vs. new linked set.
		await applyUsageCountDelta(ctx, row.linkedBlockIds ?? [], args.linkedBlockIds);
	}

	if (options.searchableFields.some((field) => args[field] !== undefined)) {
		const patched = patch as Partial<Record<SearchableField, string>>;
		const stored = row as Partial<Record<SearchableField, string>>;
		patch.searchableText = buildSearchableText(
			...options.searchableFields.map((field) => patched[field] ?? args[field] ?? stored[field])
		);
	}

	return patch;
}
