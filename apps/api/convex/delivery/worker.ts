'use node';

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { sendProviderDispatch } from '../lib/sendProviders/dispatch';
import {
	type ExtrasFor,
	type MtaExtras,
	type MtaIpPool,
	type ResendExtras,
	type SendProviderKind,
} from '../lib/sendProviders';
import { getUnsubscribeUrl, getListUnsubscribeHeader } from './unsubscribe';
import { getPreferenceUrl } from './preferences';
import { jsonPrimitiveValue } from '../lib/convexValidators';
import { getMtaConfig, scanAttachmentBytes } from '../mail/mtaClient';
import { transformHtml } from './sendComposition/transform';
import { fetchGuarded } from '../lib/ssrfGuard';
import { composeForSend, type CampaignComposeInput, type ComposeInput } from './sendComposition';
import { assertMarketingOneClickHeaders, type EmailPurpose } from './marketingCompliance';
import { resolveLastMileRouting } from './lastMileRouting';

/**
 * Email Worker Action for Workpool-based Email Sending
 *
 * This module provides:
 * - sendSingleEmail: Internal action that sends one email via provider
 *
 * The workpool completion handler is the Send completion (module) at
 * `delivery/sendCompletion.ts` — it must live in a non-Node file because
 * mutations cannot run in Node.js runtime.
 *
 * Used by both transactional and campaign email pools.
 */

// ─── Worker envelope input ───────────────────────────────────────────────
// The discriminated union the workpool passes to `sendSingleEmail`. Carries
// per-kind composition data plus routing fields (`to`, `from`, `replyTo`,
// `providerType`). The worker turns this into a `ComposeInput` for the
// per-kind composer, then dispatches the composed envelope.

const attachmentRefValidator = v.object({
	filename: v.string(),
	contentType: v.optional(v.string()),
	url: v.string(),
});

const envelopeInputValidator = v.union(
	v.object({
		kind: v.literal('campaign'),
		to: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		template: v.object({
			subject: v.string(),
			htmlContent: v.string(),
		}),
		contactInfo: v.object({
			contactId: v.optional(v.id('contacts')),
			email: v.string(),
			firstName: v.optional(v.string()),
			lastName: v.optional(v.string()),
		}),
		audienceType: v.optional(v.union(v.literal('topic'), v.literal('segment'))),
		emailSendId: v.optional(v.id('emailSends')),
		// Gmail FBL — the campaign + singleton org id let the composer emit a
		// per-campaign `Feedback-ID` header for Postmaster spam-rate granularity.
		campaignId: v.optional(v.id('campaigns')),
		organizationId: v.optional(v.string()),
		siteUrl: v.optional(v.string()),
		convexSiteUrl: v.optional(v.string()),
		trackingBaseUrl: v.optional(v.string()),
		viewInBrowserUrl: v.optional(v.string()),
		// RFC 2919 List-Id header value for a TOPIC campaign, pre-built by the
		// orchestrator (`getListIdHeader`) from the topic id/name + sending
		// domain. Absent for segment campaigns.
		listId: v.optional(v.string()),
	}),
	v.object({
		kind: v.literal('transactional'),
		emailPurpose: v.union(v.literal('marketing'), v.literal('transactional')),
		to: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		// The `transactionalSends._id` this envelope sends for. Used ONLY to
		// derive a stable provider idempotency key (see `deriveIdempotencyKey`)
		// so a surviving retry de-dupes at the MTA / Resend instead of double-
		// sending. Optional for back-compat with any in-flight enqueue.
		sendId: v.optional(v.id('transactionalSends')),
		template: v.object({
			subject: v.string(),
			htmlContent: v.string(),
		}),
		dataVariables: v.optional(v.record(v.string(), jsonPrimitiveValue)),
		attachmentRefs: v.optional(v.array(attachmentRefValidator)),
		// Custom MIME headers (e.g. In-Reply-To / References for agent replies).
		// Merged below; the composer's own headers (e.g. `Feedback-ID`) win on
		// key collision.
		headers: v.optional(v.record(v.string(), v.string())),
		// RFC 3834 Auto-Submitted classification (see TransactionalComposeInput).
		// `auto-replied` for the agent 1:1 reply path (an automatic reply to a
		// specific inbound message); omitted → the composer defaults to
		// `auto-generated` for system/DOI/transactional + automation mail.
		autoSubmittedType: v.optional(v.union(v.literal('auto-generated'), v.literal('auto-replied'))),
		// Unsubscribe footer wiring — set when the template's `showUnsubscribe`
		// flag is on. The worker builds the HMAC unsubscribe/preference URLs
		// (Node-only) from `siteUrl` + `contactId`, mirroring the campaign path.
		showUnsubscribe: v.optional(v.boolean()),
		contactId: v.optional(v.id('contacts')),
		siteUrl: v.optional(v.string()),
		// Gmail FBL — singleton org id; the composer emits a `txn`-stream
		// `Feedback-ID` header so transactional spam complaints aggregate apart
		// from bulk campaign sends.
		organizationId: v.optional(v.string()),
		// List-Unsubscribe header wiring for MARKETING non-campaign sends
		// (automation drip/broadcast steps). When `listUnsubscribe` is set and a
		// `contactId` + `convexSiteUrl` are present, the worker builds the RFC 8058
		// one-click header (Node-only HMAC) and merges it onto the envelope so
		// Gmail/Yahoo's 2024 bulk rule is satisfied. Transactional/agent sends
		// leave it unset (no List-Unsubscribe on 1:1 mail).
		listUnsubscribe: v.optional(v.boolean()),
		convexSiteUrl: v.optional(v.string()),
	})
);

type WorkerEnvelopeInput =
	| {
			kind: 'campaign';
			to: string;
			from: string;
			replyTo?: string;
			providerType?: string;
			ipPool?: string;
			template: { subject: string; htmlContent: string };
			contactInfo: {
				contactId?: import('../_generated/dataModel').Id<'contacts'>;
				email: string;
				firstName?: string;
				lastName?: string;
			};
			audienceType?: 'topic' | 'segment';
			emailSendId?: import('../_generated/dataModel').Id<'emailSends'>;
			campaignId?: import('../_generated/dataModel').Id<'campaigns'>;
			organizationId?: string;
			siteUrl?: string;
			convexSiteUrl?: string;
			trackingBaseUrl?: string;
			viewInBrowserUrl?: string;
			listId?: string;
	  }
	| {
			kind: 'transactional';
			emailPurpose: EmailPurpose;
			to: string;
			from: string;
			replyTo?: string;
			providerType?: string;
			ipPool?: string;
			sendId?: import('../_generated/dataModel').Id<'transactionalSends'>;
			template: { subject: string; htmlContent: string };
			dataVariables?: Record<string, unknown>;
			attachmentRefs?: { filename: string; contentType?: string; url: string }[];
			headers?: Record<string, string>;
			autoSubmittedType?: 'auto-generated' | 'auto-replied';
			showUnsubscribe?: boolean;
			contactId?: import('../_generated/dataModel').Id<'contacts'>;
			siteUrl?: string;
			organizationId?: string;
			// Marketing List-Unsubscribe wiring for automation steps — see the
			// validator above. The worker builds + merges the header when both
			// `listUnsubscribe` and `convexSiteUrl` + `contactId` are present.
			listUnsubscribe?: boolean;
			convexSiteUrl?: string;
	  };

/** Stable Send-row key used by MTA and Resend to deduplicate surviving retries. */
function deriveIdempotencyKey(envelopeInput: WorkerEnvelopeInput): string | undefined {
	const sendRowId =
		envelopeInput.kind === 'campaign' ? envelopeInput.emailSendId : envelopeInput.sendId;
	return sendRowId ? `send_${sendRowId}` : undefined;
}

/**
 * Build the RFC 8058 one-click `List-Unsubscribe` header for a MARKETING
 * non-campaign send (automation drip/broadcast). Returns `{}` for every other
 * envelope (campaigns carry the header via the composer; transactional/agent
 * 1:1 mail must NOT carry it). The HMAC token is built here so the Node-only
 * crypto in `getListUnsubscribeHeader` stays in the Node worker runtime.
 */
export function buildTransactionalListUnsubscribe(
	envelopeInput: WorkerEnvelopeInput
): Record<string, string> {
	if (
		envelopeInput.kind !== 'transactional' ||
		envelopeInput.listUnsubscribe !== true ||
		envelopeInput.contactId === undefined ||
		!envelopeInput.convexSiteUrl
	) {
		return {};
	}
	const header = getListUnsubscribeHeader(envelopeInput.convexSiteUrl, envelopeInput.contactId);
	return {
		'List-Unsubscribe': header.listUnsubscribe,
		'List-Unsubscribe-Post': header.listUnsubscribePost,
	};
}

export function buildComposeInput(envelopeInput: WorkerEnvelopeInput): ComposeInput {
	if (envelopeInput.kind === 'transactional') {
		// Build the unsubscribe + preference footer URLs only when the template
		// opted in (`showUnsubscribe`) AND the send has a resolvable contact +
		// site URL — same prebuild-HMAC-in-Node idiom as the campaign branch.
		const showFooter =
			envelopeInput.showUnsubscribe === true &&
			envelopeInput.contactId !== undefined &&
			!!envelopeInput.siteUrl;
		const unsubscribeUrl = showFooter
			? getUnsubscribeUrl(envelopeInput.siteUrl!, envelopeInput.contactId!)
			: undefined;
		const preferenceUrl = showFooter
			? getPreferenceUrl(envelopeInput.siteUrl!, envelopeInput.contactId!)
			: undefined;
		return {
			kind: 'transactional',
			template: envelopeInput.template,
			dataVariables: envelopeInput.dataVariables,
			attachmentRefs: envelopeInput.attachmentRefs,
			autoSubmittedType: envelopeInput.autoSubmittedType,
			unsubscribeUrl,
			preferenceUrl,
			organizationId: envelopeInput.organizationId,
		};
	}

	// Campaign — prebuild the HMAC URLs (Node-only) before the composer slots
	// them into the envelope's headers and transformConfig.
	//
	// The in-body unsubscribe footer (unsubscribe/preference URLs) is topic-only:
	// segments are computed audiences with no single topic to render in the
	// footer copy. The `List-Unsubscribe` HEADER, however, is built for ALL
	// audiences (topic AND segment) — the RFC 8058 one-click endpoint removes the
	// contact by id across every topic, and Gmail/Yahoo's 2024 bulk-sender rule
	// requires the header on segment blasts just as much as topic newsletters.
	const isTopic = envelopeInput.audienceType !== 'segment';
	const hasContact = envelopeInput.contactInfo.contactId !== undefined;

	const unsubscribeUrl =
		isTopic && hasContact && envelopeInput.siteUrl
			? getUnsubscribeUrl(envelopeInput.siteUrl, envelopeInput.contactInfo.contactId!)
			: undefined;
	const preferenceUrl =
		isTopic && hasContact && envelopeInput.siteUrl
			? getPreferenceUrl(envelopeInput.siteUrl, envelopeInput.contactInfo.contactId!)
			: undefined;
	const listUnsubscribeHeader =
		hasContact && envelopeInput.convexSiteUrl
			? getListUnsubscribeHeader(envelopeInput.convexSiteUrl, envelopeInput.contactInfo.contactId!)
			: undefined;

	const trackingBaseUrl =
		envelopeInput.emailSendId && envelopeInput.convexSiteUrl
			? (envelopeInput.trackingBaseUrl ?? envelopeInput.convexSiteUrl)
			: undefined;

	const composeInput: CampaignComposeInput = {
		kind: 'campaign',
		template: envelopeInput.template,
		contactInfo: envelopeInput.contactInfo,
		audienceType: envelopeInput.audienceType,
		emailSendId: envelopeInput.emailSendId,
		campaignId: envelopeInput.campaignId,
		organizationId: envelopeInput.organizationId,
		unsubscribeUrl,
		preferenceUrl,
		listUnsubscribeHeader,
		// RFC 2919 List-Id — the orchestrator pre-builds it from the topic +
		// sending domain (`getListIdHeader`) and threads it through the envelope.
		// Segment campaigns carry none. Forwarded verbatim to the composer.
		listId: envelopeInput.listId,
		trackingBaseUrl,
		viewInBrowserUrl: envelopeInput.viewInBrowserUrl,
	};
	return composeInput;
}

// Fetch + validate + scan one attachment ref. ClamAV is fail-open: when the
// MTA scan endpoint is unavailable, file-type validation alone gates the
// send.
async function resolveAttachments(
	refs: { filename: string; contentType?: string; url: string }[]
): Promise<{ filename: string; content: Buffer; contentType?: string }[]> {
	return Promise.all(
		refs.map(async (att) => {
			// SSRF guard: the attachment URL is attacker-influenced (any API-key
			// holder can supply it) and the fetched bytes are emailed back to an
			// attacker-chosen recipient. Validate the destination against the
			// private/internal blocklist and refuse redirects (https:// only —
			// uploadAttachments already enforces the scheme up front). 15s cap.
			const res = await fetchGuarded(att.url, {
				protocols: ['https:'],
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) {
				throw new Error(
					`Failed to fetch attachment "${att.filename}": ${res.status} ${res.statusText}`
				);
			}
			const content = Buffer.from(await res.arrayBuffer());

			// Security: Validate file type before sending
			const { validateFile } = await import('@owlat/email-scanner/files');
			const firstBytes = new Uint8Array(content.subarray(0, 32));
			// Probe the ISO 9660 descriptor at offset 0x8001 to catch renamed ISOs.
			const isoProbe =
				content.length >= 0x8006 ? new Uint8Array(content.subarray(0x8001, 0x8006)) : undefined;
			const fileValidation = validateFile(
				att.filename,
				firstBytes,
				undefined,
				content.length,
				isoProbe
			);

			if (!fileValidation.allowed) {
				throw new Error(`Attachment "${att.filename}" blocked: ${fileValidation.reason}`);
			}

			// Security: ClamAV malware scan via the shared MTA client. The client
			// owns the POST + fail-open (not-configured / scanner-down / network
			// error all resolve to 'skipped' and are surfaced via warnScanSkipped)
			// AND the single config source — this path no longer reads
			// MTA_INTERNAL_URL/MTA_API_KEY itself, so it can't drift from
			// getMtaConfig() (which also accepts MTA_API_URL as a fallback). This
			// path's POLICY: a confirmed-infected verdict throws so the send aborts.
			const scanVerdict = await scanAttachmentBytes(getMtaConfig(), att.filename, content);
			if (scanVerdict.kind === 'infected') {
				throw new Error(
					`Attachment "${att.filename}" blocked by malware scan: ${scanVerdict.reason}`
				);
			}

			return {
				filename: att.filename,
				content,
				contentType: att.contentType,
			};
		})
	);
}

/**
 * Internal action to send a single email via configured provider.
 * Called by workpool for each queued email.
 *
 * Args shrink to a single `envelopeInput` discriminated union; per-kind
 * composition (subject + html personalize, headers, transform config)
 * lives in `delivery/sendComposition/`. The worker stays policy-agnostic
 * and applies whatever the composer hands back.
 */
export const sendSingleEmail = internalAction({
	args: {
		envelopeInput: envelopeInputValidator,
	},
	handler: async (ctx, { envelopeInput }) => {
		// Suppression re-check — campaign path only. Campaigns filter the blocklist
		// once, at audience-resolution time, then enqueue. But the timezone path
		// can schedule a send up to ~24h out and the rate-limited campaign queue
		// can run long, so a recipient who hard-bounces / complains / is manually
		// blocked AFTER resolution but BEFORE this worker runs would still receive
		// the already-queued campaign email. Re-read the blocklist here — the last
		// gate before dispatch — to honor the suppression obligation (CAN-SPAM
		// §316.5 + the Gmail/Yahoo 2024 sender requirements). O(1) indexed point
		// read via `blockedEmails.by_email`; NOT a scan. The non-campaign path
		// already gates at enqueue (delivery/enqueue.ts), so it is not re-checked.
		if (envelopeInput.kind === 'campaign') {
			const blocked = await ctx.runQuery(internal.blockedEmails.isBlockedInternal, {
				email: envelopeInput.to,
			});
			if (blocked) {
				// Finalize as skipped without delivering. Return normally (do NOT
				// throw) so the workpool run counts as a success and does not retry;
				// the Send completion handler translates `suppressed` into a terminal
				// non-delivery transition (status 'failed', code RECIPIENT_SUPPRESSED).
				return { success: false, suppressed: true };
			}
		}

		const composeInput = buildComposeInput(envelopeInput);
		const composed = composeForSend(composeInput);
		const html = composed.transformConfig
			? transformHtml(composed.html, composed.transformConfig)
			: composed.html;

		const resolvedAttachments =
			composed.attachmentRefs.length > 0
				? await resolveAttachments(composed.attachmentRefs)
				: undefined;

		// Merge any envelope-supplied custom headers (transactional kind only —
		// e.g. In-Reply-To / References for agent replies) onto the composer's
		// headers. The composer's headers win on key collision.
		const envelopeHeaders =
			envelopeInput.kind === 'transactional' ? envelopeInput.headers : undefined;
		// Automation one-click headers are built here; campaigns carry theirs from the composer.
		const marketingHeaders = buildTransactionalListUnsubscribe(envelopeInput);
		const mergedHeaders = {
			...envelopeHeaders,
			...marketingHeaders,
			...composed.headers,
		};
		const emailPurpose: EmailPurpose =
			envelopeInput.kind === 'campaign' ? 'marketing' : envelopeInput.emailPurpose;
		assertMarketingOneClickHeaders(emailPurpose, mergedHeaders);

		const idempotencyKey = deriveIdempotencyKey(envelopeInput);
		if (!idempotencyKey) {
			throw new Error('Delivery safety decision requires a stable Send idempotency key.');
		}
		const {
			providerKind,
			route: lastMileRoute,
			organizationId,
			routingLease,
		} = await resolveLastMileRouting(ctx, {
			kind: envelopeInput.kind,
			to: envelopeInput.to,
			from: envelopeInput.from,
			providerType: envelopeInput.providerType,
			ipPool: envelopeInput.ipPool,
			organizationId: envelopeInput.organizationId,
			idempotencyKey,
		});

		// Send via the Send dispatch helper. The helper owns retries, error
		// categorization, and `providerHealth` recording for every attempt.
		//
		// Thread a stable, Send-row-derived idempotency key so any surviving
		// retry de-dupes at the boundary: MTA dedups on `messageId`, Resend on
		// the `Idempotency-Key` header. SES has no idempotency surface (its
		// adapter treats a post-dispatch timeout as TERMINAL instead).
		const extras: ExtrasFor<SendProviderKind> =
			providerKind === 'mta'
				? ({
						messageId: idempotencyKey,
						organizationId,
						routingLease,
						...((lastMileRoute?.ipPool ?? envelopeInput.ipPool)
							? { ipPool: (lastMileRoute?.ipPool ?? envelopeInput.ipPool) as MtaIpPool }
							: {}),
					} satisfies MtaExtras)
				: providerKind === 'resend'
					? ({ idempotencyKey } satisfies ResendExtras)
					: {};
		const dispatched = await sendProviderDispatch(
			ctx,
			providerKind,
			{
				to: envelopeInput.to,
				from: envelopeInput.from,
				replyTo: envelopeInput.replyTo,
				subject: composed.subject,
				html,
				// Plain-text alternative derived from the UNTRACKED composer html
				// (the tracking pixel + link rewriting are applied to `html`
				// above) so the text/plain part carries no pixel/redirect URL.
				text: composed.text,
				headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
				attachments: resolvedAttachments,
			},
			extras
		);

		if (dispatched.result.success) {
			return {
				success: true,
				providerMessageId:
					providerKind === 'mta' && idempotencyKey && dispatched.result.id !== idempotencyKey
						? idempotencyKey
						: dispatched.result.id, // MTA-only: keep the VERP token, not a dedup sentinel, so bounce/complaint DSNs resolve by_provider_message_id (Resend/SES keep their own ids)
				providerType: dispatched.providerType,
				sendLatencyMs: dispatched.latencyMs,
			};
		}

		throw new Error(dispatched.result.errorMessage || 'Unknown email sending error');
	},
});
