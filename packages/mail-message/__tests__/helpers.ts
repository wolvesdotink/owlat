/**
 * Shared test fixtures for `@owlat/mail-message`. Both `compose.test.ts` and
 * `headers.test.ts` build the same neutral `ComposeInput`, so the builder lives
 * here once instead of being duplicated in each file.
 */

import type { ComposeInput } from '../src/index';

/** A minimal, valid `ComposeInput`; pass `overrides` to vary a single field. */
export function makeInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
	return {
		toAddresses: ['rcpt@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		fromAddress: 'sender@owlat.test',
		subject: 'Weekly update',
		bodyHtml: '<p>Hello</p>',
		bodyText: 'Hello',
		...overrides,
	};
}
