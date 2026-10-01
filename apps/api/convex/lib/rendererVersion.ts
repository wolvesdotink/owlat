/**
 * `rendererVersion` on publishable emails (`emailTemplates`,
 * `transactionalEmails`): the renderer version that produced the HTML the row
 * stores (`htmlContent` and `htmlTranslations`). Every write that stores HTML
 * stamps it, so a share-link snapshot, a duplicate or an account export
 * carries the right provenance. See CONVENTIONS.md "Versioning rules"; the
 * version itself and its history live in `@owlat/email-renderer/version`.
 */

import { v } from 'convex/values';

/**
 * The version of HTML stored without one: rows written before writes were
 * stamped, and clients from before they reported the renderer they ran. Both
 * produced version 1 output.
 */
export const UNSTAMPED_RENDERER_VERSION = 1;

/**
 * Mutation arg beside rendered HTML: the `@owlat/email-renderer` version
 * (`EMAIL_RENDERER_VERSION`) that rendered the HTML in the same call. Optional
 * so older clients keep working; their HTML is stamped version 1.
 */
export const rendererVersionArg = v.optional(v.number());

/** Whether the `htmlTranslations` blob holds HTML for any language. */
function hasTranslatedHtml(blob: string | undefined): boolean {
	if (!blob) return false;
	try {
		const parsed = JSON.parse(blob) as unknown;
		return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
	} catch {
		// The send path ignores an unreadable blob, so it delivers no HTML.
		return false;
	}
}

/**
 * The `rendererVersion` a row records after a write that stores HTML.
 *
 * `renderedWith` is the renderer version that produced the written HTML, or
 * undefined when the caller did not report one (version 1). `writes` says what
 * the write replaces: the default-language HTML, the whole `htmlTranslations`
 * blob, or neither (a single language's entry).
 *
 * When none of the row's earlier HTML is left, the row records `renderedWith`.
 * Otherwise the row now holds the output of two renderers, and it records the
 * older one, so nothing reading the version assumes newer HTML than some of
 * the row has.
 */
export function rendererVersionAfterWrite(
	row: { rendererVersion?: number; htmlContent?: string; htmlTranslations?: string },
	renderedWith: number | undefined,
	writes: { htmlContent: boolean; htmlTranslations: boolean }
): number {
	const written = renderedWith ?? UNSTAMPED_RENDERER_VERSION;
	const replacesAll =
		(writes.htmlContent || row.htmlContent === undefined) &&
		(writes.htmlTranslations || !hasTranslatedHtml(row.htmlTranslations));
	if (replacesAll) return written;
	return Math.min(row.rendererVersion ?? UNSTAMPED_RENDERER_VERSION, written);
}
