/**
 * Core types for the owlat-mta service
 */

// ============ Email Job Types ============

export interface EmailJob {
	/** Owlat internal message ID for correlation (becomes providerMessageId in Convex) */
	messageId: string;
	/** Unique bounded work identity; provider correlation remains messageId. */
	workAttemptId?: string;
	/** Recipient email address */
	to: string;
	/** Sender email address */
	from: string;
	/** Email subject line */
	subject: string;
	/** HTML content */
	html: string;
	/** Plain text content (auto-generated from HTML if omitted) */
	text?: string;
	/**
	 * Postbox-only complete PGP/MIME message. When present the SMTP sender uses
	 * these exact bytes instead of rebuilding MIME from `html`/`text`.
	 */
	sealedMimeBase64?: string;
	/**
	 * AMP4Email content. When present, delivered as a `text/x-amp-html`
	 * alternative part so AMP-capable clients (Gmail, Yahoo, Mail.ru) render
	 * the interactive version; everyone else falls through to the HTML part.
	 */
	amp?: string;
	/** Optional reply-to address */
	replyTo?: string;
	/** Optional custom headers */
	headers?: Record<string, string>;
	/**
	 * Optional MIME attachments. Used by internally-generated mail (e.g.
	 * TLS-RPT aggregate reports per RFC 8460 §5.3) — the public /send route
	 * does not populate this. `contentBase64` is the raw attachment bytes
	 * base64-encoded so the job survives JSON serialization through Redis.
	 */
	attachments?: EmailAttachment[];
	/** IP pool for routing: transactional (time-sensitive) or campaign (bulk) */
	ipPool: IpPoolType;
	/** Organization ID for circuit breaker and webhook correlation */
	organizationId: string;
	/** Authenticated production-vs-member-preview effect domain. */
	deliveryDomain?: import('@owlat/shared').DeliveryDomain;
	/** Engagement score 0-100 from Convex contact activity (for priority ordering) */
	engagementScore?: number;
	/** Domain for DKIM signing */
	dkimDomain: string;
	/**
	 * Wall-clock ms when the message was *first* enqueued. Set on the initial
	 * `queue.add` and carried verbatim across every defer re-enqueue so the
	 * worker can enforce a max-message-age give-up (RFC 5321 §4.5.4.1) that
	 * survives re-queues. Absent on legacy jobs — the worker falls back to the
	 * GroupMQ `ReservedJob.timestamp` of the current attempt.
	 */
	firstEnqueuedAt?: number;
	/** Authenticated last-mile routing lease issued by this MTA. */
	routingLease?: {
		token: string;
		destinationProvider: DestinationProviderKey;
		probe: boolean;
		globalProbe?: boolean;
		ip?: string;
		eligibilityGeneration?: number;
		globalBreakerGeneration?: number;
		providerBreakerGeneration?: number;
		warmingReservation?: {
			ip: string;
			messageId: string;
			utcDate: string;
			expiresAt: number;
		};
	};
	/** Opaque handle to server-side Convex state; contains no tenant content. */
	routingReentryToken?: string;
	/** Callback material whose canonical digest is authenticated by the token. */
	routingReentry?: {
		envelopeInput: unknown;
		retryState: { attempt: number; startedAt: number; idempotencyKey: string };
	};
}

export type IpPoolType = 'transactional' | 'campaign';

/** A single MIME attachment carried on an {@link EmailJob}. */
export interface EmailAttachment {
	/** Suggested filename (Content-Disposition). */
	filename: string;
	/** MIME type, e.g. `application/tlsrpt+gzip`. */
	contentType: string;
	/** Raw attachment bytes, base64-encoded. */
	contentBase64: string;
}

export interface EmailJobResult {
	success: boolean;
	/** Raw SMTP response string on success */
	smtpResponse?: string;
	/** Remote message ID from the receiving server's SMTP response */
	remoteMessageId?: string;
	/** Error message on failure */
	error?: string;
	/**
	 * Bounce classification. `'ambiguous'` is the post-DATA drop with no server
	 * reply (AMBIGUOUS_TIMEOUT, W8): the message may already have been accepted,
	 * so it is TERMINAL but must NOT be treated as a hard bounce — no recipient
	 * suppression and no bounce-reputation penalties (see `dispatch/outcome.ts`).
	 */
	bounceType?: 'hard' | 'soft' | 'deferred' | 'ambiguous';
	/** SMTP response code */
	smtpCode?: number;
	/** Enhanced status code (e.g., 5.1.1) */
	enhancedCode?: string;
}

// ============ Webhook Event Types ============

export type MtaWebhookEventType =
	| 'sent'
	| 'bounced'
	| 'failed'
	| 'complained'
	| 'org.circuit_breaker'
	| 'campaign.complaint_rate'
	| 'ip.blocklisted'
	| 'ip.delisted'
	| 'ip.warming_complete'
	| 'all_ips_blocked'
	| 'postmaster.authorize_domain'
	| 'postmaster.stats'
	| 'dkim.rotated'
	| 'inbound.received'
	| 'routing.reentry'
	| 'inbound.mailbox.received';

export interface MtaWebhookEvent {
	/** Event type */
	event: MtaWebhookEventType;
	/** Owlat message ID for correlation */
	messageId?: string;
	/**
	 * Complained/bounced recipient address. Carried on `complained` events
	 * extracted from an ARF feedback-report part (RFC 5965 §3.2) when no
	 * original Message-ID is recoverable, so Convex can suppress the
	 * complainer by email instead of dropping the complaint.
	 */
	recipient?: string;
	/** Organization ID (for org-level events) */
	organizationId?: string;
	deliveryDomain?: import('@owlat/shared').DeliveryDomain;
	/** Phase-2 MX-derived receiver identity for accepted-delivery telemetry. */
	destinationProvider?: DestinationProviderKey;
	/** PSL-correct primary sending domain used by Gmail's bulk classification. */
	primarySendingDomain?: string;
	/** Bounce type (for bounce events) */
	bounceType?: 'hard' | 'soft';
	/** Human-readable message */
	message?: string;
	/** Affected IP (for IP events) */
	ip?: string;
	/** Blocklists the IP is listed on */
	blocklists?: string[];
	/** Remote message ID assigned by the receiving server */
	remoteMessageId?: string;
	/** Severity level */
	severity?: 'info' | 'warning' | 'critical';
	/** Bounce rate (for circuit breaker events) */
	bounceRate?: number;
	/** Sending domain (for dkim.rotated events) */
	domain?: string;
	/** New DKIM selector (for dkim.rotated events) */
	selector?: string;
	/** New DKIM public-key DNS TXT record value (for dkim.rotated events) */
	dnsRecord?: string;
	/**
	 * DKIM rotation phase (for dkim.rotated events): `'pending'` when the new
	 * selector is published alongside the active one during the overlap,
	 * `'activated'` once signing switches and the old selector retires.
	 */
	phase?: 'pending' | 'activated';
	/** Campaign ID (for campaign.complaint_rate events) */
	campaignId?: string;
	/** Complaint rate as a fraction 0..1 (for campaign.complaint_rate events) */
	complaintRate?: number;
	/** Google Postmaster daily observation fields (`postmaster.stats`). */
	date?: string;
	userReportedSpamRatio?: number;
	/** Inbound email payload (for inbound.received events) */
	inboundPayload?: InboundEmailPayload;
	/** Personal-mailbox payload (for inbound.mailbox.received events) */
	mailboxPayload?: MailboxInboundPayload;
	/** Opaque Convex state handle for a pre-network routing re-entry. */
	routingReentryToken?: string;
	workAttemptId?: string;
	routingReentry?: {
		envelopeInput: unknown;
		retryState: { attempt: number; startedAt: number; idempotencyKey: string };
	};
	routingReentryReason?:
		| 'routing_lease_stale'
		| 'circuit_breaker_changed'
		| 'warming_capacity_changed';
	/** Timestamp */
	timestamp: number;
}

export interface GooglePostmasterStatsEvent extends MtaWebhookEvent {
	event: 'postmaster.stats';
	domain: string;
	date: string;
	userReportedSpamRatio: number;
}

export interface GooglePostmasterDomainAuthorizationEvent extends MtaWebhookEvent {
	event: 'postmaster.authorize_domain';
	domain: string;
}

export type GooglePostmasterWebhookEvent =
	| GooglePostmasterDomainAuthorizationEvent
	| GooglePostmasterStatsEvent;

/**
 * RFC 8601 inbound authentication verdicts plus the DMARC alignment inputs, as
 * computed by the MTA over the raw bytes at ingest. Every field is optional: a
 * disabled check (or an absent identity) leaves it `undefined`, which the
 * downstream consumer must render as "unknown" — never as a pass.
 */
export interface InboundAuthVerdicts {
	/** SPF result on the SMTP envelope MAIL FROM (RFC 7208 §2.6 keyword). */
	spfResult?: string;
	/** DKIM result on the strongest signature (RFC 6376 / RFC 8601 keyword). */
	dkimResult?: string;
	/** DMARC result binding SPF/DKIM to the From domain (RFC 7489). */
	dmarcResult?: string;
	/** Published DMARC policy (`none`/`quarantine`/`reject`) for the From domain. */
	dmarcPolicy?: string;
	/** DMARC alignment input: the SMTP envelope MAIL FROM domain. */
	envelopeFromDomain?: string;
	/** DMARC alignment input: the d= domain of the passing DKIM signature. */
	dkimSigningDomain?: string;
	/**
	 * ARC chain-validation result (`cv=`, RFC 8617, Sealed Mail A5). Only `pass`
	 * is eligible to rescue a DMARC fail. Absent on older MTA builds / no chain.
	 */
	arcCv?: string;
	/** `d=` of the outermost ARC seal — the forwarder vouching for the message. */
	arcSealerDomain?: string;
	/**
	 * Whether the sealer's sealed ARC-Authentication-Results attest the ORIGINAL
	 * message passed DMARC (or carried an aligned, passing SPF/DKIM). Convex only
	 * honours a trusted-forwarder rescue when this is true.
	 */
	arcAttestsOriginalPass?: boolean;
}

/** Personal-mailbox (Postbox) inbound payload — includes raw RFC822 for storage */
export interface MailboxInboundPayload extends InboundAuthVerdicts {
	deliveryId: string;
	recipientAddress: string;
	rawBytesBase64: string;
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo?: string;
	/**
	 * SMTP envelope sender (RFC 5321 MAIL FROM / return-path). `''` for the
	 * null sender (`<>`) of a bounce/DSN. Downstream uses this — not the
	 * spoofable `From:` header — to suppress vacation auto-replies to bounces
	 * (RFC 3834 §2). Optional for backward compatibility with older MTA builds.
	 */
	returnPath?: string;
	subject: string;
	textBody?: string;
	htmlBody?: string;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	date?: number;
	attachments: Array<{
		filename: string;
		contentType: string;
		size: number;
		contentId?: string;
		partIndex: string;
	}>;
	spamScore?: number;
	spamVerdict?: 'ham' | 'spam' | 'quarantine';
	virusVerdict?: 'clean' | 'infected' | 'skipped';
}

/** Parsed inbound email content forwarded to Convex (AI-inbox `inbound.received`) */
export interface InboundEmailPayload extends Pick<
	InboundAuthVerdicts,
	'spfResult' | 'dkimResult' | 'dmarcResult' | 'dmarcPolicy'
> {
	from: string;
	to: string;
	subject: string;
	textBody?: string;
	htmlBody?: string;
	headers: Record<string, string>;
	date?: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string;
	attachments: Array<{
		filename?: string;
		contentType: string;
		size: number;
		// Note: attachment content is NOT included in the webhook payload
		// to avoid size issues. Attachments can be fetched separately via MTA API.
		redisKey?: string;
	}>;
}

// ============ Domain Throttle Types ============

export interface DestinationProviderProfile {
	/** Default sending rate (emails per minute) */
	defaultRate: number;
	/** Maximum rate ceiling */
	ceiling: number;
	/** Minimum rate floor */
	floor: number;
	/** Multiplier on 4xx (e.g., 0.5 = halve the rate) */
	backoffFactor: number;
	/** Multiplier on sustained success (e.g., 1.1 = +10%) */
	recoveryFactor: number;
	/** Provider TLS floor composed with local, MTA-STS, and DANE policy. */
	tlsMode: import('@owlat/shared').OutboundTlsMode;
	/** Maximum live SMTP connection lineages for this provider. */
	maxConnections: number;
	/** Deliveries allowed over one SMTP connection before a clean recycle. */
	maxDeliveriesPerConnection: number;
}

export type DomainHealthStatus = 'healthy' | 'degraded' | 'blocking';

// ============ SMTP Intelligence Types ============

export interface SmtpResponseRecord {
	code: number;
	enhancedCode?: string;
	timestamp: number;
}

export type SmtpDomainStatus = 'healthy' | 'degraded' | 'blocking';

// ============ Circuit Breaker Types ============

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerState {
	status: CircuitState;
	openedAt?: number;
	cooldownUntil?: number;
	tripReason?: string;
	halfOpenSent?: number;
	/** Bounces + complaints during half-open test */
	halfOpenBounced?: number;
}

// ============ Warming Types ============

export type WarmingPhase = 'ramp' | 'plateau' | 'graduated';

export interface WarmingState {
	startedAt: number;
	currentDay: number;
	dailyCap: number;
	sentToday: number;
	sentTodayReset: string; // YYYY-MM-DD
	/** UTC date (YYYY-MM-DD) the warming schedule was last advanced — per-day idempotency guard for evaluateDay */
	lastEvaluatedDate: string;
	bounceRate: number;
	deferralRate: number;
	phase: WarmingPhase;
}

// ============ IP Pool Types ============

export interface IpPoolConfig {
	transactional: string[];
	campaign: string[];
}

// ============ DKIM Types ============

export interface DkimKeyConfig {
	selector: string;
	privateKey: string;
}

// ============ Bounce Types ============

export interface BounceClassification {
	type: 'bounced' | 'complained';
	bounceType: 'hard' | 'soft';
	message: string;
	diagnosticCode?: string;
	originalMessageId?: string;
	organizationId?: string;
	/**
	 * The complained/bounced recipient address, extracted from the ARF
	 * feedback-report part (RFC 5965 §3.2 `Original-Rcpt-To` /
	 * `Removed-Recipient` / `Original-Recipient`). Used to suppress the
	 * complainer by email when the original Message-ID is unrecoverable
	 * (e.g. Gmail FBL redacts the original message), so a complaint still
	 * lands the recipient on the blocklist rather than evaporating into a
	 * metric. RFC 5321/5322 ABNF redaction is common, so this is the only
	 * attribution handle on a large fraction of real-world complaints.
	 */
	recipient?: string;
	/**
	 * Campaign identifier extracted from the original message's `Feedback-ID`
	 * header (field 2, `campaign` stream — see
	 * `delivery/sendComposition/feedbackId.ts`). Lets a complaint be rate-tracked
	 * per-campaign even when no `organizationId` is extractable, closing the gap
	 * where unattributed complaints never entered any rate window.
	 */
	campaignId?: string;
	/**
	 * ARF `Feedback-Type` from the structured `message/feedback-report` part
	 * (RFC 5965 §3.2 / §7.3 registry): `abuse`, `fraud`, `virus`, `not-spam`,
	 * `auth-failure`, … For a "Report Spam" complaint this is `abuse`. Surfaced
	 * so downstream can tell a spam complaint apart from other report classes
	 * rather than treating every ARF as a hard complaint.
	 */
	feedbackType?: string;
	/**
	 * ARF `Reported-Domain` — the domain being complained about (RFC 5965 §3.2),
	 * read from the structured feedback-report part rather than guessed.
	 */
	reportedDomain?: string;
	/**
	 * ARF `Source-IP` — the IP the reported message was received from (RFC 5965
	 * §3.2), read from the structured feedback-report part.
	 */
	sourceIp?: string;
	/**
	 * Normalized source ISP (a bounded `\w+` enum: `google`, `microsoft`,
	 * `yahoo`, `comcast`, `aol`, `mailru`). Derived from the structured
	 * feedback-report `User-Agent`/`Reported-Domain`/`Source-IP` fields, falling
	 * back to the `Received` trace, rather than only guessing from `Received`.
	 */
	sourceIsp?: string;
}

// ============ Metrics Types ============

export type MetricOutcome = 'delivered' | 'bounced' | 'deferred' | 'rejected' | 'error';

export type DestinationProviderKey = 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other';
