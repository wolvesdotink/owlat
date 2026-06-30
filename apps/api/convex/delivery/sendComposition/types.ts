/**
 * Send composition (module) — shared types and the discriminated input union.
 *
 * Mirrors the per-kind-module-with-registry pattern of Block module, Step
 * module, Contact activity module, Webhook event module, and Integration
 * import provider adapter module. The `kind` literal discriminates the
 * registry's compile-time `satisfies` check; adding a sixth kind is a
 * one-folder change.
 */

import type { Id } from '../../_generated/dataModel';
import type { TransformConfig } from './transform';

export type SendCompositionKind =
	| 'campaign'
	| 'transactional'
	| 'test'
	| 'archive_snapshot'
	| 'automation';

export type AttachmentRef = {
	filename: string;
	contentType?: string;
	url: string;
};

export type ComposeOutput = {
	subject: string;
	html: string;
	/**
	 * Plain-text alternative (RFC 2046 §5.1.4) derived from the *untracked*
	 * `html` above by `composeForSend`. The producer passes this to the
	 * provider so the `text/plain` part is clean content — NOT a regex strip of
	 * the tracked HTML (which would carry `/t/c/` redirect links and is one
	 * tweak from leaking the tracking-pixel URL). Populated centrally in
	 * `composeForSend`, so per-kind composers do not set it.
	 */
	text: string;
	headers: Record<string, string>;
	attachmentRefs: AttachmentRef[];
	transformConfig: TransformConfig | null;
};

/**
 * The per-kind composer return shape: everything in `ComposeOutput` except the
 * `text` alternative. `composeForSend` derives `text` from the untracked `html`
 * centrally, so individual composers never produce it.
 */
export type ComposerOutput = Omit<ComposeOutput, 'text'>;

/**
 * Contact-info inputs accepted by composers that personalize against a
 * contact (campaign, test, automation). Index signature is required so the
 * shape is assignable to `Record<string, unknown>` — `personalize` accepts
 * arbitrary variable keys, and call sites (Mailchimp imports, custom
 * properties) can extend with their own variables.
 */
export type ContactInfo = {
	contactId?: Id<'contacts'>;
	email: string;
	firstName?: string;
	lastName?: string;
	[key: string]: unknown;
};

/**
 * Campaign composer input. The unsubscribe / preference / List-Unsubscribe
 * URL fields are pre-built by the caller — they require HMAC (Node-only) so
 * the producer builds them once before composing. The composer slots them
 * into the headers and transformConfig.
 */
export type CampaignComposeInput = {
	kind: 'campaign';
	template: { subject: string; htmlContent: string };
	contactInfo: ContactInfo;
	audienceType?: 'topic' | 'segment';
	emailSendId?: Id<'emailSends'>;
	// Gmail FBL granularity — when both are present the campaign composer emits
	// a `Feedback-ID` header (`campaign:<campaignId>:<audienceType>:<senderId>`)
	// so spam complaints aggregate per campaign in Postmaster Tools. The
	// `organizationId` anchors a stable SenderId across the whole mail stream.
	campaignId?: Id<'campaigns'>;
	// The BetterAuth org id (a string, single-org-per-deployment). Anchors the
	// stable Feedback-ID SenderId; not a Convex table id.
	organizationId?: string;
	// Pre-built URLs (caller owns HMAC)
	unsubscribeUrl?: string;
	preferenceUrl?: string;
	listUnsubscribeHeader?: {
		listUnsubscribe: string;
		listUnsubscribePost: string;
	};
	// Pre-built RFC 2919 `List-Id` header value for a topic campaign (e.g.
	// `"Topic Name" <topic-<id>.<sending-domain>>`). Built by the orchestrator
	// from the campaign's topic + sending domain via `getListIdHeader`; the
	// composer slots it verbatim into `headers['List-Id']`. Omitted for segment
	// audiences (no single topic to identify) and any campaign without it.
	listId?: string;
	// Tracking
	trackingBaseUrl?: string;
	viewInBrowserUrl?: string;
};

export type TransactionalComposeInput = {
	kind: 'transactional';
	template: { subject: string; htmlContent: string };
	dataVariables?: Record<string, unknown>;
	attachmentRefs?: AttachmentRef[];
	// RFC 3834 Auto-Submitted classification. The transactional composer is the
	// collapse point for several 1:1 producers (system/DOI mail, automation
	// steps, and agent 1:1 replies). `auto-generated` (the default when omitted)
	// is for mail NOT produced in response to a specific message; an automatic
	// REPLY to a specific inbound message (the agent_reply path) must instead
	// stamp `auto-replied` (RFC 3834 §2 + §5). Either value is `!= no`, so both
	// stay loop-safe under `isAutomatedMail`. Threaded from the producer rather
	// than hardcoded by kind because all of these collapse to this one composer.
	autoSubmittedType?: 'auto-generated' | 'auto-replied';
	// Pre-built unsubscribe + preference footer URLs (caller owns HMAC). Set
	// only when the template's `showUnsubscribe` flag is on and the send has a
	// resolvable contact; the composer slots them into the transform config so
	// the worker appends the unsubscribe footer. Omitted → no footer (default).
	unsubscribeUrl?: string;
	preferenceUrl?: string;
	// Gmail FBL granularity — when present the transactional composer emits a
	// `Feedback-ID` header on the `txn` stream (distinct from the `campaign`
	// stream) so transactional/automation spam complaints aggregate separately.
	// The BetterAuth org id (a string) anchors the stable SenderId.
	organizationId?: string;
};

export type TestComposeInput = {
	kind: 'test';
	template: { subject: string; htmlContent: string };
	sampleContact: Record<string, unknown>;
};

export type ArchiveSnapshotComposeInput = {
	kind: 'archive_snapshot';
	template: { subject: string; htmlContent: string };
};

export type AutomationComposeInput = {
	kind: 'automation';
	template: { subject: string; htmlContent: string };
	contactInfo: ContactInfo;
	// Pre-built List-Unsubscribe header (caller owns HMAC). Set for marketing
	// automation steps (drip series, broadcasts) so Gmail/Yahoo's 2024 bulk-
	// sender rule is satisfied. Omitted → no header (the composer emits none).
	listUnsubscribeHeader?: {
		listUnsubscribe: string;
		listUnsubscribePost: string;
	};
};

export type ComposeInput =
	| CampaignComposeInput
	| TransactionalComposeInput
	| TestComposeInput
	| ArchiveSnapshotComposeInput
	| AutomationComposeInput;

export type ComposeInputForKind<K extends SendCompositionKind> = Extract<
	ComposeInput,
	{ kind: K }
>;
