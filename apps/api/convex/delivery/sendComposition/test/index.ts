/**
 * Send composition (module) — `test` composer.
 *
 * Owns subject + html personalization for test sends against a synthesized
 * `sampleContact` (test email, `Test`, `User`, plus any custom data
 * variables the editor supplies). Returns `transformConfig: null` — test
 * sends never receive view-in-browser, unsubscribe footer, tracking
 * pixel, or link wrapping.
 *
 * The `[TEST]` subject prefix is *not* applied here — the producer
 * (`emailsSending.ts`) owns that prefix because it composes the
 * language-suffix `(${lang})` indicator alongside.
 */

import { personalize } from '../personalization';
import type { ComposerOutput, TestComposeInput } from '../types';

export function composeTest(input: TestComposeInput): ComposerOutput {
	const subject = personalize(input.template.subject, input.sampleContact, {
		escape: 'header',
	});
	const html = personalize(input.template.htmlContent, input.sampleContact, {
		escape: 'html',
	});

	return {
		subject,
		html,
		headers: {},
		attachmentRefs: [],
		transformConfig: null,
	};
}
