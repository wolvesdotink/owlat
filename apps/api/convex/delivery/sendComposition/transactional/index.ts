/**
 * Send composition (module) — `transactional` composer.
 *
 * Owns subject + html personalization against `dataVariables`, and merges
 * the input's `attachmentRefs` into the envelope. Emits a `transformConfig`
 * carrying the unsubscribe + preference footer ONLY when the caller supplied
 * the pre-built URLs (template `showUnsubscribe` on + a resolvable contact);
 * otherwise returns `transformConfig: null` — transactional emails do not
 * receive view-in-browser, tracking pixel, or link wrapping.
 *
 * If product later decides transactional emails should carry tracking, the
 * change is a single composer file.
 */

import { buildFeedbackId } from '../feedbackId';
import { personalize } from '../personalization';
import type { TransformConfig } from '../transform';
import type {
	ComposerOutput,
	TransactionalComposeInput,
} from '../types';

export function composeTransactional(
	input: TransactionalComposeInput,
): ComposerOutput {
	const vars = input.dataVariables ?? {};
	const subject = personalize(input.template.subject, vars, { escape: 'header' });
	const html = personalize(input.template.htmlContent, vars, { escape: 'html' });

	// Gmail FBL: the `txn` stream token keeps transactional + automation spam
	// complaints in a separate Postmaster bucket from bulk `campaign` sends.
	const headers: Record<string, string> = {};
	// RFC 3834: machine-generated 1:1 mail is stamped Auto-Submitted so receiving
	// auto-responders (incl. another Owlat instance via isAutomatedMail) suppress
	// replies. `auto-generated` (the default) is for mail not produced in response
	// to a message — system/DOI/transactional and automation sends; an automatic
	// REPLY to a specific inbound message (the agent_reply path) sets
	// `autoSubmittedType: 'auto-replied'` per RFC 3834 §2. Both values are `!= no`,
	// so either keeps the message loop-safe.
	headers['Auto-Submitted'] = input.autoSubmittedType ?? 'auto-generated';
	if (input.organizationId) {
		const feedbackId = buildFeedbackId({
			streamType: 'txn',
			organizationId: input.organizationId,
		});
		if (feedbackId) {
			headers['Feedback-ID'] = feedbackId;
		}
	}

	// The footer needs BOTH the unsubscribe and preference URLs (matching the
	// transform's `if (unsubscribeUrl && preferenceUrl)` gate). The producer
	// only builds them when the template opts in via `showUnsubscribe`.
	let transformConfig: TransformConfig | null = null;
	if (input.unsubscribeUrl && input.preferenceUrl) {
		transformConfig = {
			unsubscribeUrl: input.unsubscribeUrl,
			preferenceUrl: input.preferenceUrl,
		};
	}

	return {
		subject,
		html,
		headers,
		attachmentRefs: input.attachmentRefs ?? [],
		transformConfig,
	};
}
