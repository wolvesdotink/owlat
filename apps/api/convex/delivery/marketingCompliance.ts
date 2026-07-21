/**
 * Marketing-send compliance — the final pre-dispatch RFC 8058 invariant.
 *
 * This module is deliberately the only assertion site. Campaign and automation
 * producers may assemble their headers differently, but the worker presents the
 * final merged envelope here immediately before provider dispatch. The DKIM
 * assertion reads the signer's exported contract rather than duplicating its
 * header list, so composition and signing cannot silently drift apart.
 */

import { SIGNED_HEADERS } from '@owlat/mail-message';
import { parseListUnsubscribe } from '@owlat/shared/listUnsubscribe';

export type EmailPurpose = 'marketing' | 'transactional';

const REQUIRED_ONE_CLICK_HEADERS = ['list-unsubscribe', 'list-unsubscribe-post'] as const;

function normalizedHeaders(headers: Readonly<Record<string, string>>): Map<string, string> {
	return new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** Assert that a final marketing envelope is RFC 8058-capable and DKIM-covered. */
export function assertMarketingOneClickHeaders(
	purpose: EmailPurpose,
	headers: Readonly<Record<string, string>>
): void {
	if (purpose !== 'marketing') return;

	const presentHeaders = normalizedHeaders(headers);
	const signedHeaders = new Set(SIGNED_HEADERS.map((name) => name.toLowerCase()));
	for (const requiredHeader of REQUIRED_ONE_CLICK_HEADERS) {
		if (!presentHeaders.has(requiredHeader)) {
			throw new Error(`Marketing email is missing required ${requiredHeader} header`);
		}
		if (!signedHeaders.has(requiredHeader)) {
			throw new Error(`DKIM signed-header contract is missing ${requiredHeader}`);
		}
	}

	const parsed = parseListUnsubscribe(
		presentHeaders.get('list-unsubscribe'),
		presentHeaders.get('list-unsubscribe-post')
	);
	if (!parsed?.oneClick) {
		throw new Error('Marketing email does not carry a valid RFC 8058 one-click unsubscribe target');
	}
}
