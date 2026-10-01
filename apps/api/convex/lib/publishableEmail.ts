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
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { throwInvalidState } from '../_utils/errors';
import { applyUsageCountDelta } from '../emailBlocks/module';
import { CURRENT_CONTENT_BLOCK_VERSION } from './constants';
import { nextContentRevision } from './contentRevision';
import { rendererVersionAfterWrite, UNSTAMPED_RENDERER_VERSION } from './rendererVersion';
import { parseTranslations } from './emailTranslations';
import { buildSearchableText } from './queryHelpers';
import { sanitizeStoredBlocksJson, sanitizeTranslationsJson } from './emailContentSanitize';

export type PublishableEmailRow = Doc<'emailTemplates'> | Doc<'transactionalEmails'>;

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
 * The HTML a publish puts live: the row's own rendered HTML, read in the same
 * transaction as the status change.
 *
 * Client HTML is not trusted here. The editor sends the HTML of the row it last
 * saw, and a saved-block rerender can replace the row's HTML without moving its
 * content revision; publishing the client's copy after that would put the
 * pre-propagation HTML live on a row whose render state says it is current.
 * For the same reason a row whose HTML is still behind its content (a rerender
 * pending or failed) is refused instead of published.
 *
 * `rendererVersion` is set only when the caller's HTML is used: it is the
 * version the row records for that HTML (see lib/rendererVersion.ts).
 */
export function publishedHtml(
	row: Pick<
		PublishableEmailRow,
		'htmlContent' | 'htmlTranslations' | 'htmlRenderState' | 'rendererVersion'
	>,
	args: { htmlContent?: string; htmlTranslations?: string; rendererVersion?: number }
): { htmlContent: string; htmlTranslations?: string; rendererVersion?: number } {
	if (row.htmlRenderState?.stale) {
		throwInvalidState(
			'A saved block this email uses changed and its HTML is still being updated, so it was not published. Try again in a moment.',
			{
				reason: 'html_render_pending',
				messageKey: 'dashboard.send.emails.detail.edit.toasts.htmlStillRendering',
			}
		);
	}
	if (row.htmlContent !== undefined) {
		return { htmlContent: row.htmlContent, htmlTranslations: row.htmlTranslations };
	}
	// Never rendered (created outside the editor): the caller's HTML is all there is.
	if (args.htmlContent === undefined) {
		throwInvalidState('Save the email before publishing it.', {
			reason: 'html_missing',
			messageKey: 'dashboard.send.emails.detail.edit.toasts.saveBeforePublish',
		});
	}
	return {
		htmlContent: args.htmlContent,
		htmlTranslations: args.htmlTranslations,
		rendererVersion: rendererVersionAfterWrite(row, args.rendererVersion, {
			htmlContent: true,
			htmlTranslations: args.htmlTranslations !== undefined,
		}),
	};
}

// ─── Duplicate ──────────────────────────────────────────────────────────────

/**
 * Columns a copy never inherits: identity, publish state, timestamps,
 * per-row bookkeeping and the render state (handled separately below).
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
 * A source whose HTML is still behind its content (`htmlRenderState.stale`)
 * passes that state on, so the copy's stale HTML cannot be published either.
 * Text-block HTML in the copied content and translation overlays is sanitized,
 * as on every other content write.
 *
 * The caller sets the copy's name (and slug), `searchableText`,
 * `status: 'draft'`, `createdAt` and `updatedAt`.
 */
export function duplicateEmailFields<T extends PublishableEmailRow>(
	row: T
): Omit<T, NotDuplicated> & Pick<Partial<T>, 'htmlRenderState'> {
	const copy: Record<string, unknown> = { ...row };
	for (const key of NOT_DUPLICATED) delete copy[key];
	if (row.htmlRenderState?.stale) copy['htmlRenderState'] = row.htmlRenderState;
	copy['content'] = sanitizeStoredBlocksJson(row.content);
	if (row.translations !== undefined) {
		copy['translations'] = sanitizeTranslationsJson(row.translations);
	}
	copy['contentBlockVersion'] = row.contentBlockVersion ?? CURRENT_CONTENT_BLOCK_VERSION;
	// The copy holds the source's HTML, so it keeps the source's renderer version.
	copy['rendererVersion'] = row.rendererVersion ?? UNSTAMPED_RENDERER_VERSION;
	return copy as Omit<T, NotDuplicated> & Pick<Partial<T>, 'htmlRenderState'>;
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
	/** The renderer version that produced `htmlContent` / `htmlTranslations`. */
	rendererVersion?: number;
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
	rendererVersion?: number;
	linkedBlockIds?: string[];
	searchableText?: string;
	htmlRenderState?: { stale: boolean };
	contentRevision: number;
	updatedAt: number;
}

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
	options: { noun: string; searchableFields: ReadonlyArray<SearchableField> }
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
	if (args.htmlContent !== undefined) patch.htmlContent = args.htmlContent;

	// Blocks and the HTML rendered from them, in one write: the HTML matches
	// the content again, so a saved-block rerender still pending for the
	// previous revision has nothing left to fix (it no-ops on the moved row).
	if (args.content !== undefined && args.htmlContent !== undefined && row.htmlRenderState) {
		patch.htmlRenderState = { stale: false };
	}

	if (args.plainTextContent !== undefined) patch.plainTextContent = args.plainTextContent;
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
	if (args.htmlTranslations !== undefined) patch.htmlTranslations = args.htmlTranslations;
	if (args.htmlContent !== undefined || args.htmlTranslations !== undefined) {
		patch.rendererVersion = rendererVersionAfterWrite(row, args.rendererVersion, {
			htmlContent: args.htmlContent !== undefined,
			htmlTranslations: args.htmlTranslations !== undefined,
		});
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
