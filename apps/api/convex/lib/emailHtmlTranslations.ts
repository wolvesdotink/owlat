/**
 * The `htmlTranslations` blob on publishable emails: each non-default
 * language's delivery HTML and subject, keyed by language code. The send path
 * (campaign `getForSend`, transactional `selectContent`) delivers a recipient's
 * language straight from it, so an entry must belong to the same content
 * revision as the overlay it was rendered from. The translation mutations
 * write the two in one patch (see `lib/emailTranslations.ts`).
 */

/** One language's delivery HTML, as stored in the blob. */
interface RenderedLanguage {
	htmlContent: string;
	subject: string;
}

/**
 * The patch that sets `language`'s entry to `rendered`, or removes it when
 * `rendered` is null. An unreadable blob is replaced: the send path already
 * ignores one, so nothing it held was being delivered.
 */
export function renderedLanguagePatch(
	blob: string | undefined,
	language: string,
	rendered: RenderedLanguage | null
): { htmlTranslations: string } {
	let current: Record<string, RenderedLanguage> = {};
	try {
		current = blob ? (JSON.parse(blob) as Record<string, RenderedLanguage>) : {};
	} catch {
		current = {};
	}
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { [language]: _previous, ...others } = current;
	return {
		htmlTranslations: JSON.stringify(rendered ? { ...others, [language]: rendered } : others),
	};
}
