/**
 * Send composition (module) — `automation` composer.
 *
 * Owns subject + html personalization for automation-step email sends.
 * Returns `transformConfig: null` — automation emails ship without
 * view-in-browser, in-body unsubscribe footer, tracking pixel, or link
 * wrapping.
 *
 * Marketing automation steps (drip series, broadcasts) DO carry a
 * `List-Unsubscribe` header: when the caller supplies a pre-built
 * `listUnsubscribeHeader` the composer slots both `List-Unsubscribe` and
 * `List-Unsubscribe-Post` into the envelope, satisfying Gmail/Yahoo's 2024
 * bulk-sender requirement. Omitted → no header (transactional-style step).
 */

import { personalize } from '../personalization';
import type {
	AutomationComposeInput,
	ComposerOutput,
} from '../types';

export function composeAutomation(input: AutomationComposeInput): ComposerOutput {
	const subject = personalize(input.template.subject, input.contactInfo, {
		escape: 'header',
	});
	const html = personalize(input.template.htmlContent, input.contactInfo, {
		escape: 'html',
	});

	// RFC 3834 §5: automation-step mail is machine-generated, so stamp
	// Auto-Submitted: auto-generated. Receiving auto-responders (incl.
	// another Owlat instance via isAutomatedMail) then suppress replies.
	const headers: Record<string, string> = { 'Auto-Submitted': 'auto-generated' };
	if (input.listUnsubscribeHeader) {
		headers['List-Unsubscribe'] = input.listUnsubscribeHeader.listUnsubscribe;
		headers['List-Unsubscribe-Post'] = input.listUnsubscribeHeader.listUnsubscribePost;
	}

	return {
		subject,
		html,
		headers,
		attachmentRefs: [],
		transformConfig: null,
	};
}
