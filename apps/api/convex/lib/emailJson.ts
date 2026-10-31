/**
 * The shapes of the email JSON blobs kept in string columns: a row's
 * per-language translation overlays (`translations`) and the HTML rendered from
 * them (`htmlTranslations`).
 *
 * Pure and runtime-neutral: the queries, mutations and the `'use node'`
 * rerender action all read these blobs through here, so a field the readers
 * rely on is checked in one place. Fields a reader does not use are left on the
 * value unchecked, so a row a newer release wrote still decodes. What a reader
 * does with a blob that fails (fall back to the default language, skip the
 * translated renders, refuse the write) stays the reader's policy; a failure
 * names where the value failed, never what it held.
 */

import { v, type Infer } from 'convex/values';
import { isRecord } from '@owlat/shared/utils/guards';
import { guardDecoder, validatorDecoder, type Decoded } from '@owlat/worker-protocol/decodeJson';
import { decodeJsonString } from './jsonText';

/** One block's translatable text in a language overlay. */
const translatableBlockContentValidator = v.object({
	html: v.optional(v.string()),
	buttonText: v.optional(v.string()),
	alt: v.optional(v.string()),
});

/** A language overlay's per-block text, keyed by block id. */
const overlayBlocksValidator = v.record(v.string(), translatableBlockContentValidator);

/**
 * One stored language overlay. `subject` and `blocks` are optional: overlays
 * created from the Settings page carried only the subject and preview text,
 * and older rows may lack the subject, so every reader falls back to the
 * default subject and the unmerged blocks.
 */
const storedTranslationValidator = v.object({
	subject: v.optional(v.string()),
	previewText: v.optional(v.string()),
	blocks: v.optional(overlayBlocksValidator),
});

const storedTranslationsValidator = v.record(v.string(), storedTranslationValidator);

/** One language's rendered delivery HTML in `htmlTranslations`. */
const htmlTranslationValidator = v.object({ htmlContent: v.string(), subject: v.string() });

export type OverlayBlocks = Infer<typeof overlayBlocksValidator>;
export type StoredTranslation = Infer<typeof storedTranslationValidator>;
export type HtmlTranslation = Infer<typeof htmlTranslationValidator>;

const decodeHtmlTranslation = validatorDecoder(htmlTranslationValidator);

/** A `translations` blob: every language's overlay, keyed by language code. */
export function decodeStoredTranslations(json: string): Decoded<Record<string, StoredTranslation>> {
	return decodeJsonString(json, storedTranslationsValidator);
}

/** One language's per-block overlay text, as a translation update sends it. */
export function decodeOverlayBlocks(json: string): Decoded<OverlayBlocks> {
	return decodeJsonString(json, overlayBlocksValidator);
}

/**
 * The rendered HTML of `language` in an `htmlTranslations` blob: `undefined`
 * when the blob has no entry for it, a failure when the blob or that entry is
 * malformed. Only the requested entry is checked, so one damaged language does
 * not take the others down with it.
 */
export function pickHtmlTranslation(
	json: string,
	language: string
): Decoded<HtmlTranslation | undefined> {
	const checked = decodeJsonString(json, guardDecoder(isRecord, '$: expected object'));
	if (!checked.ok) return checked;
	if (!Object.prototype.hasOwnProperty.call(checked.value, language)) {
		return { ok: true, value: undefined };
	}
	const entry = decodeHtmlTranslation(checked.value[language]);
	return entry.ok ? entry : { ok: false, issue: entry.issue.replace(/^\$/, '$[*]') };
}
