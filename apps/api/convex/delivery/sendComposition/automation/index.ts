/**
 * Send composition (module) — `automation` composer.
 *
 * Owns subject + html personalization for automation-step email sends. The
 * step uses only the personalized subject and html: it hands them to the
 * non-campaign intake, and the worker composes the delivered envelope as the
 * `transactional` kind. That is where an automation step gets its
 * `List-Unsubscribe` header pair and, with it, the unsubscribe footer
 * (`delivery/worker.ts`). This composer therefore returns
 * `transformConfig: null`.
 *
 * When a caller supplies a pre-built `listUnsubscribeHeader`, the composer
 * slots both `List-Unsubscribe` and `List-Unsubscribe-Post` into the headers.
 */

import { automationVariables, personalize } from '../personalization';
import type { AutomationComposeInput, ComposerOutput } from '../types';

export function composeAutomation(input: AutomationComposeInput): ComposerOutput {
	const subject = personalize(input.template.subject, input.contactInfo, {
		escape: 'header',
	});
	const html = personalize(input.template.htmlContent, automationVariables(input.contactInfo), {
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
