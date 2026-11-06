/**
 * The document an AI client's send previews in its approval card: the HTML
 * part as it goes out, under the reader's defences for mail it did not write.
 * The client wrote it, so it is treated like received mail: the shared Postbox
 * sanitizer (which drops scripts, `<style>`, `<meta>` refreshes and forms) and
 * the reader's no-network policy, so neither a remote image nor a font loads
 * while the owner looks. The card frames it with `sandbox=""`.
 *
 * The preview keeps inline styles, so text the sender made tiny or the colour
 * of the page looks that way here too. The card lists every link's real target
 * beside it, because a preview shows a link's text, not where it goes.
 */

import { buildBaseStyle } from '~/utils/postboxBaseStyle';
import {
	POSTBOX_BODY_META_CSP_NO_REMOTE,
	POSTBOX_SRCDOC_HEAD,
} from '~/utils/postboxBodyPlaceholder';
import { sanitizePostboxHtml } from '~/utils/postboxSanitizeHtml';

export function mcpReviewPreviewSrcdoc(html: string): string {
	return `${POSTBOX_SRCDOC_HEAD}${POSTBOX_BODY_META_CSP_NO_REMOTE}${buildBaseStyle('light')}</head><body>${sanitizePostboxHtml(html)}</body></html>`;
}
