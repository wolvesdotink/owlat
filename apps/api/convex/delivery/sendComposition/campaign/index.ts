/**
 * Send composition (module) — `campaign` composer.
 *
 * Full envelope composition for kind: 'campaign'. Owns subject + html
 * personalization, List-Unsubscribe header assembly, and the transform
 * config (view-in-browser, tracking pixel, link-wrapping base, unsubscribe
 * + preference footer URLs).
 *
 * Topic vs segment audiences:
 *  - `audienceType: 'segment'` campaigns skip the in-body unsubscribe footer
 *    (segments are computed audiences with no single topic to render in the
 *    footer copy) but STILL emit the `List-Unsubscribe` header when the caller
 *    supplies one — the RFC 8058 one-click endpoint removes the contact across
 *    all topics by contactId, so it is meaningful for any audience. Gmail/Yahoo
 *    require the header on bulk mail regardless of how the audience was built.
 *  - `audienceType: 'topic'` (or undefined for backwards compat) campaigns
 *    get the full footer + List-Unsubscribe header.
 */

import { buildFeedbackId } from '../feedbackId';
import { personalize } from '../personalization';
import { getTrackingPixelUrl } from '../trackingUrl';
import type { TransformConfig } from '../transform';
import type {
	CampaignComposeInput,
	ComposerOutput,
} from '../types';

export function composeCampaign(input: CampaignComposeInput): ComposerOutput {
	const subject = personalize(input.template.subject, input.contactInfo, { escape: 'header' });
	const html = personalize(input.template.htmlContent, input.contactInfo, { escape: 'html' });

	// Campaign mail is bulk, machine-generated marketing. RFC 2076 / Gmail &
	// Yahoo 2024 bulk-sender rules: stamp Precedence: bulk so receiving MTAs
	// and auto-responders treat it as bulk, and Auto-Submitted: auto-generated
	// (RFC 3834 §5) so auto-responders (incl. another Owlat instance via
	// isAutomatedMail) suppress replies and don't form loops.
	const headers: Record<string, string> = {
		Precedence: 'bulk',
		'Auto-Submitted': 'auto-generated',
	};
	// List-Unsubscribe is emitted for ALL audiences (topic AND segment) when the
	// caller supplies the pre-built header — the one-click endpoint removes by
	// contactId across every topic, so it is valid for computed segments too.
	if (input.listUnsubscribeHeader) {
		headers['List-Unsubscribe'] = input.listUnsubscribeHeader.listUnsubscribe;
		headers['List-Unsubscribe-Post'] = input.listUnsubscribeHeader.listUnsubscribePost;
	}
	// List-Id (RFC 2919): the stable mailing-list handle for a TOPIC campaign,
	// pre-built by the orchestrator (`getListIdHeader`) from the topic id/name +
	// sending domain. Segment campaigns supply none — a computed segment has no
	// single list identity to advertise. Emitted verbatim when supplied.
	if (input.listId) {
		headers['List-Id'] = input.listId;
	}

	// Gmail FBL: per-campaign granularity on the `campaign` stream. Emitted
	// whenever a stable sender anchor (organizationId) is available; the
	// campaignId lands in field 2 so complaints aggregate per campaign.
	if (input.organizationId) {
		const feedbackId = buildFeedbackId({
			streamType: 'campaign',
			organizationId: input.organizationId,
			campaignId: input.campaignId,
			audienceType: input.audienceType,
		});
		if (feedbackId) {
			headers['Feedback-ID'] = feedbackId;
		}
	}

	const transformConfig: TransformConfig = {};

	if (input.viewInBrowserUrl) {
		transformConfig.viewInBrowserUrl = input.viewInBrowserUrl;
	}

	if (
		input.audienceType !== 'segment' &&
		input.unsubscribeUrl &&
		input.preferenceUrl
	) {
		transformConfig.unsubscribeUrl = input.unsubscribeUrl;
		transformConfig.preferenceUrl = input.preferenceUrl;
	}

	if (input.emailSendId && input.trackingBaseUrl) {
		transformConfig.trackingPixelUrl = getTrackingPixelUrl(
			input.trackingBaseUrl,
			input.emailSendId,
		);
		transformConfig.trackedLinkBase = {
			siteUrl: input.trackingBaseUrl,
			emailSendId: input.emailSendId,
		};
	}

	const hasTransform = Object.keys(transformConfig).length > 0;

	return {
		subject,
		html,
		headers,
		attachmentRefs: [],
		transformConfig: hasTransform ? transformConfig : null,
	};
}
