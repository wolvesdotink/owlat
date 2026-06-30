/**
 * Pure helpers for placing a chosen signature inside the composer body.
 *
 * A signature is prepended to a fresh draft as a marked block so the composer
 * can later swap it for a different one (the per-message picker) without
 * clobbering whatever the user typed above it. The marker is an inert
 * `data-` attribute — it survives the sanitize-html allowlist and the
 * email renderer, and is invisible to recipients.
 *
 * The block looks like:
 *   <br><br><div data-postbox-signature>…signature html…</div>
 */

/** Attribute marking the signature block so we can find/replace it later. */
const SIGNATURE_MARKER = 'data-postbox-signature';

/**
 * Matches the leading `<br><br>` (optional) plus the marked signature `<div>`,
 * anchored to the end of the body. Anchoring to the tail keeps the user's
 * fresh content (typed above) untouched when the signature is swapped.
 */
const SIGNATURE_BLOCK_RE = new RegExp(
	`(?:<br\\s*/?>\\s*){0,2}<div[^>]*\\b${SIGNATURE_MARKER}\\b[^>]*>[\\s\\S]*</div>\\s*$`,
	'i'
);

/** Wrap signature HTML in the marked block, with the usual leading spacing. */
export function wrapSignatureBlock(html: string): string {
	return `<br><br><div ${SIGNATURE_MARKER}="true">${html}</div>`;
}

/** True when the body already carries a signature block we can swap. */
export function bodyHasSignatureBlock(body: string): boolean {
	return SIGNATURE_BLOCK_RE.test(body);
}

/**
 * Strip the trailing signature block (if any) from the body, returning the
 * fresh content the user typed above it.
 */
export function stripSignatureBlock(body: string): string {
	return body.replace(SIGNATURE_BLOCK_RE, '');
}

/**
 * Apply a chosen signature to the body:
 *   - if a signature block is already present, replace it in place;
 *   - otherwise append a fresh block (keeping any content the user typed).
 *
 * `html` empty means "no signature" — an existing block is removed.
 */
export function applySignatureToBody(body: string, html: string): string {
	const base = stripSignatureBlock(body);
	if (!html) return base;
	return base + wrapSignatureBlock(html);
}
