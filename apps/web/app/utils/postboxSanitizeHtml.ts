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
