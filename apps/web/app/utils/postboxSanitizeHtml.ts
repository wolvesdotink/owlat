/**
 * Sanitize user-authored Postbox HTML for safe rendering with `v-html`.
 *
 * Snippet bodies and signatures are sanitized on save in the Convex mutations
 * (`mail/snippets.ts`, `mail/signatures.ts`), but the settings previews render
 * the stored value directly into the page — outside the reader iframe that
 * defends inbound mail. Any row written before save-time sanitization landed,
 * or by any path that bypasses those mutations, would otherwise execute in the
 * app origin. Sanitizing again at the render boundary makes these previews
 * safe regardless of how the stored HTML got there.
 *
 * Reuses the shared `POSTBOX_SANITIZE_CONFIG` allowlist so the render policy
 * stays in lock-step with the save-time and reader-side policies.
 */

import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';

/** Run user-authored Postbox HTML through the shared allowlist. */
export function sanitizePostboxHtml(html: string): string {
	return sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
}

/**
 * The composer's variant of the shared allowlist, applied to every value the
 * Postbox editor writes into its `contenteditable` (mount and external model
 * writes such as draft hydration). On top of the shared policy it keeps the
 * markup the editor itself produces: the `data-inline-cid` marker and `blob:`
 * preview source of a pasted inline image, and the `target` / `rel` pair the
 * link command sets.
 */
const POSTBOX_COMPOSER_SANITIZE_CONFIG: sanitizeHtml.IOptions = {
	...POSTBOX_SANITIZE_CONFIG,
	allowedAttributes: {
		...(POSTBOX_SANITIZE_CONFIG.allowedAttributes || {}),
		a: ['href', 'title', 'name', 'target', 'rel'],
		img: ['src', 'srcset', 'alt', 'width', 'height', 'loading', 'data-inline-cid'],
	},
	allowedSchemesByTag: {
		...POSTBOX_SANITIZE_CONFIG.allowedSchemesByTag,
		img: ['http', 'https', 'cid', 'data', 'blob'],
	},
};

/** Run HTML bound for the Postbox composer's `contenteditable` through its allowlist. */
export function sanitizePostboxComposerHtml(html: string): string {
	return sanitizeHtml(html, POSTBOX_COMPOSER_SANITIZE_CONFIG);
}
