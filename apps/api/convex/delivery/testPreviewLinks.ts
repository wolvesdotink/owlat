/**
 * The unsubscribe links of a test preview.
 *
 * A marketing preview carries the footer and the RFC 8058 header pair a real
 * send carries, so the member sees what recipients get. Their links must not
 * act on anybody: a preview is addressed to a member, not to a contact, and
 * its links are public. So the footer opens the recipient pages in a preview
 * state that says this was a test (`?preview=test`, no token), and the
 * one-click target is a fixed endpoint that answers like the real one and
 * records nothing (`delivery/testPreviewHttp.ts`). No token is minted, so
 * nothing in a preview can be replayed against a contact.
 */

import type { FooterUrls } from './sendComposition/footer';

/**
 * The one-click path of a preview. `testPreviewHttp.ts` registers the same
 * literal as an exact route, matched before the `/unsub/` token prefix.
 */
const TEST_PREVIEW_ONE_CLICK_PATH = '/unsub/test-preview';

/** What the recipient pages read to show their preview state. */
export const TEST_PREVIEW_QUERY = 'preview=test';

const trimOrigin = (url: string) => url.trim().replace(/\/+$/, '');

export function testPreviewFooterUrls(siteUrl: string | undefined): FooterUrls | undefined {
	if (!siteUrl?.trim()) return undefined;
	const origin = trimOrigin(siteUrl);
	return {
		unsubscribeUrl: `${origin}/unsubscribe?${TEST_PREVIEW_QUERY}`,
		preferenceUrl: `${origin}/preferences?${TEST_PREVIEW_QUERY}`,
	};
}

export function testPreviewListUnsubscribeHeader(
	convexSiteUrl: string | undefined
): { listUnsubscribe: string; listUnsubscribePost: string } | undefined {
	if (!convexSiteUrl?.trim()) return undefined;
	return {
		listUnsubscribe: `<${trimOrigin(convexSiteUrl)}${TEST_PREVIEW_ONE_CLICK_PATH}>`,
		listUnsubscribePost: 'List-Unsubscribe=One-Click',
	};
}
