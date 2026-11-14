/**
 * Send composition (module) — `test` composer.
 *
 * Owns subject + html personalization for test sends against a synthesized
 * `sampleContact` (test email, `Test`, `User`, plus any custom data
 * variables the editor supplies).
 *
 * A marketing preview (a campaign, or an email template from its editor)
 * shows what recipients get: the unsubscribe footer, with the sender's postal
 * address and in the body's language, and the `List-Unsubscribe` header pair.
 * The caller passes both with preview links that change nothing and count as
 * nothing. Tracking stays off: no pixel, no wrapped links, no view-in-browser
 * link, because a preview has no Send to attribute them to.
 *
 * The `[TEST]` subject prefix is *not* applied here — the producer
 * (`campaigns/testSend.ts`) owns that prefix because it composes the
 * language-suffix `(${lang})` indicator alongside.
 */

import { personalize, withUnsubscribeLink } from '../personalization';
import type { TransformConfig } from '../transform';
import type { ComposerOutput, TestComposeInput } from '../types';

export function composeTest(input: TestComposeInput): ComposerOutput {
	const subject = personalize(input.template.subject, input.sampleContact, {
		escape: 'header',
	});
	const html = personalize(
		input.template.htmlContent,
		withUnsubscribeLink(input.sampleContact, input.footer?.unsubscribeUrl),
		{ escape: 'html' }
	);

	const headers: Record<string, string> = {};
	if (input.listUnsubscribeHeader) {
		headers['List-Unsubscribe'] = input.listUnsubscribeHeader.listUnsubscribe;
		headers['List-Unsubscribe-Post'] = input.listUnsubscribeHeader.listUnsubscribePost;
	}

	let transformConfig: TransformConfig | null = null;
	if (input.footer) {
		transformConfig = {
			unsubscribeUrl: input.footer.unsubscribeUrl,
			preferenceUrl: input.footer.preferenceUrl,
			...(input.footer.language ? { footerLanguage: input.footer.language } : {}),
			...(input.footer.senderAddress ? { senderAddress: input.footer.senderAddress } : {}),
		};
	}

	return {
		subject,
		html,
		headers,
		attachmentRefs: [],
		transformConfig,
	};
}
