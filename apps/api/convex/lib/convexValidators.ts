import { v, type Infer } from 'convex/values';

// Unified-message channel union (unifiedMessages.channel, channelConfigs.channel,
// and every internalMutation/query arg that names a channel). Single source of
// truth — the literal set + order here MUST match the schema columns it backs.
export const unifiedMessageChannelValidator = v.union(
	v.literal('email'),
	v.literal('sms'),
	v.literal('whatsapp'),
	v.literal('generic'),
	v.literal('chat'),
);
export type UnifiedMessageChannel = Infer<typeof unifiedMessageChannelValidator>;

// The outbound-dispatchable subset (sms/whatsapp/generic). Email is owned by the
// MTA send pipeline and chat is native, so neither is dispatched through the
// channel adapters — the contact-identifier lookup is only meaningful for these.
export const outboundChannelValidator = v.union(
	v.literal('sms'),
	v.literal('whatsapp'),
	v.literal('generic'),
);
export type OutboundChannel = Infer<typeof outboundChannelValidator>;

/** Narrows an arbitrary string (e.g. a projected inbound message's `to` field,
 * which holds the channel literal for non-email channels) to a dispatchable
 * outbound channel. */
export function isOutboundChannel(value: string): value is OutboundChannel {
	return value === 'sms' || value === 'whatsapp' || value === 'generic';
}

// Reusable: JSON-safe primitive value and record (replaces v.any() for flat key-value data)
export const jsonPrimitiveValue = v.union(v.string(), v.number(), v.boolean(), v.null());
export const jsonPrimitiveRecord = v.record(v.string(), jsonPrimitiveValue);

// Per-step result blob from the updater sidecar (systemUpdates.steps).
export const updateStepResultValidator = v.array(
	v.object({
		step: v.string(),
		stdout: v.string(),
		stderr: v.string(),
	}),
);

// Activity metadata (contactActivities)
export const activityMetadataValidator = v.object({
	campaignId: v.optional(v.string()),
	transactionalEmailId: v.optional(v.string()),
	emailSubject: v.optional(v.string()),
	emailType: v.optional(v.string()),
	linkUrl: v.optional(v.string()),
	bounceType: v.optional(v.string()),
	errorMessage: v.optional(v.string()),
	topicId: v.optional(v.string()),
	topicName: v.optional(v.string()),
	reason: v.optional(v.string()),
	propertyKey: v.optional(v.string()),
	oldValue: v.optional(v.string()),
	newValue: v.optional(v.string()),
	source: v.optional(v.string()),
	// `doi_attested` activity metadata — source label from external platform
	// (Mailchimp, Klaviyo, Stripe, …). See ADR-0019.
	attestSource: v.optional(v.string()),
});

// Data variables schema definition (transactionalEmails)
export const dataVariablesSchemaValidator = v.record(
	v.string(),
	v.union(v.literal('string'), v.literal('number'), v.literal('boolean'), v.literal('date'))
);

// ─── Webhook payload contract (FROZEN) ─────────────────────────────────────
// Per-event payload shapes are documented in apps/api/convex/docs/webhook-payloads.md.
// Any change to these shapes requires bumping CURRENT_WEBHOOK_PAYLOAD_VERSION
// in lib/constants.ts and is a breaking change for customer-side webhook receivers.
//
// The event-name union is derived from the catalog in `webhooks/events.ts`
// so a new event is a one-place change. Re-exported here so existing
// `lib/validators` consumers keep working.

import { webhookEventValidator } from '../webhooks/events';
export { webhookEventValidator };

// Container the row stores. `data` is the inner event payload — kept as
// jsonPrimitiveRecord for now (flat primitive map). Nested arrays/objects in
// the event-specific shapes (e.g. topic.unsubscribed.listsRemoved) are
// JSON-encoded into a primitive string field per the docs/webhook-payloads.md
// contract. A future v2 may switch to a discriminated union per event.
export const webhookPayloadValidator = v.object({
	event: webhookEventValidator,
	timestamp: v.string(), // ISO-8601 of when the event was emitted
	data: jsonPrimitiveRecord,
});

// Segment filters — canonical `Condition` discriminator is `kind`, per
// ADR-0004. Each kind has its own required shape; operators applicable to
// the kind live on the per-kind module.
const contactPropertyOperatorValidator = v.union(
	v.literal('equals'),
	v.literal('not_equals'),
	v.literal('contains'),
	v.literal('not_contains'),
	v.literal('gt'),
	v.literal('lt'),
	v.literal('gte'),
	v.literal('lte'),
	v.literal('is_empty'),
	v.literal('not_empty'),
	v.literal('is_true'),
	v.literal('is_false'),
);

const contactPropertyConditionValidator = v.object({
	kind: v.literal('contact_property'),
	field: v.string(),
	operator: contactPropertyOperatorValidator,
	value: v.optional(v.union(v.string(), v.number(), v.boolean())),
});
const emailActivityConditionValidator = v.object({
	kind: v.literal('email_activity'),
	field: v.union(v.literal('opened'), v.literal('clicked')),
	operator: v.union(v.literal('is_true'), v.literal('is_false')),
});
const topicMembershipConditionValidator = v.object({
	kind: v.literal('topic_membership'),
	topicId: v.string(),
	operator: v.union(v.literal('equals'), v.literal('not_equals')),
});

export const filterConditionValidator = v.union(
	contactPropertyConditionValidator,
	emailActivityConditionValidator,
	topicMembershipConditionValidator,
);
export const segmentFiltersValidator = v.object({
	logic: v.union(v.literal('AND'), v.literal('OR')),
	conditions: v.array(filterConditionValidator),
});

// A/B test config
export const abTestConfigValidator = v.object({
	testType: v.union(v.literal('subject'), v.literal('content')),
	variantBSubject: v.optional(v.string()),
	variantBTemplateId: v.optional(v.string()),
	splitPercentage: v.number(),
	winnerCriteria: v.union(v.literal('open_rate'), v.literal('click_rate'), v.literal('manual')),
	testDuration: v.optional(v.number()),
});

// Automation trigger config
export const triggerConfigValidator = v.union(
	v.object({ propertyKey: v.string() }),
	v.object({ eventName: v.string() }),
	v.object({ topicId: v.string() }),
);

// Automation step config — canonical condition-step shape:
// `{ condition: Condition, yesBranchStepIndex?, noBranchStepIndex? }` per ADR-0004.
const conditionStepConfigValidator = v.object({
	condition: filterConditionValidator,
	yesBranchStepIndex: v.optional(v.union(v.number(), v.null())),
	noBranchStepIndex: v.optional(v.union(v.number(), v.null())),
});

export const stepConfigValidator = v.union(
	v.object({ emailTemplateId: v.string(), subjectOverride: v.optional(v.string()) }),
	v.object({ duration: v.number(), unit: v.union(v.literal('minutes'), v.literal('hours'), v.literal('days'), v.literal('weeks')) }),
	conditionStepConfigValidator,
);

// DNS records.
//
// `TLSA` (RFC 6698, DANE) carries three numeric parameters before the cert
// association data — usage, selector and matching type — encoded in the record
// as `<usage> <selector> <matchingType> <hex>`. We model them as optional fields
// so the existing TXT/CNAME/MX records (which never set them) are unaffected; a
// TLSA record's `value` holds the full space-separated payload so verifiers and
// the builder UI can render it verbatim.
export const dnsRecordValidator = v.object({
	type: v.optional(
		v.union(v.literal('TXT'), v.literal('CNAME'), v.literal('MX'), v.literal('TLSA')),
	),
	host: v.optional(v.string()),
	hostname: v.optional(v.string()),
	value: v.string(),
	priority: v.optional(v.number()),
	// TLSA-only (RFC 6698 §2.1). PKIX-TA(0)/PKIX-EE(1)/DANE-TA(2)/DANE-EE(3),
	// Cert(0)/SPKI(1), and Full(0)/SHA-256(1)/SHA-512(2) respectively. Optional
	// because no other record type carries them.
	usage: v.optional(v.number()),
	selector: v.optional(v.number()),
	matchingType: v.optional(v.number()),
});
export const dnsRecordsValidator = v.object({
	spf: v.optional(dnsRecordValidator),
	dkim: v.optional(v.array(dnsRecordValidator)),
	dmarc: v.optional(dnsRecordValidator),
	mailFrom: v.optional(v.array(dnsRecordValidator)),
	// Operator's own SMTP TLS Reporting record (`_smtp._tls`, RFC 8460 §3).
	// Only present when the operator opts in via MTA_TLSRPT_RUA.
	tlsRpt: v.optional(dnsRecordValidator),
});

// Verification results
export const verificationResultValidator = v.object({
	verified: v.boolean(),
	lastChecked: v.number(),
	error: v.optional(v.string()),
	foundValue: v.optional(v.string()),
});
export const verificationResultsValidator = v.object({
	spf: v.optional(verificationResultValidator),
	dkim: v.optional(v.array(verificationResultValidator)),
	dmarc: v.optional(verificationResultValidator),
	mailFrom: v.optional(v.array(verificationResultValidator)),
	tlsRpt: v.optional(verificationResultValidator),
	sesStatus: v.optional(v.string()),
});

// Form fields
export const formFieldValidator = v.object({
	key: v.string(),
	label: v.string(),
	type: v.union(v.literal('email'), v.literal('text'), v.literal('checkbox')),
	required: v.boolean(),
});

// Campaign status union (campaigns.status). Keep CAMPAIGN_STATUSES below in
// sync — it is the closed bucket set the Listing engine's `byStatus` facet
// groups over (ADR-0037).
export const campaignStatusValidator = v.union(
	v.literal('draft'),
	v.literal('scheduled'),
	v.literal('sending'),
	v.literal('sent'),
	v.literal('cancelled'),
	v.literal('pending_review'),
);

export const CAMPAIGN_STATUSES = [
	'draft',
	'scheduled',
	'sending',
	'sent',
	'cancelled',
	'pending_review',
] as const;

// Campaign audience is a discriminated value (ADR-0033) — see
// `convex/campaigns/audience.ts` (`audienceValidator`). The flat
// `audienceTypeValidator` was removed with the four flat columns.

// Per-recipient click tracking entry (emailSends.clickedLinks, transactionalSends.clickedLinks)
export const linkClickValidator = v.object({
	url: v.string(),
	clickedAt: v.number(),
});

// Spam classification verdict (mailMessages.spamVerdict and intake args)
export const spamVerdictValidator = v.union(
	v.literal('ham'),
	v.literal('spam'),
	v.literal('quarantine'),
);

// Postbox reader auto-advance preference (mailUserSettings.autoAdvance and
// mail/settings update args) — single source so schema and args can't drift.
export const mailAutoAdvanceValidator = v.union(
	v.literal('next'),
	v.literal('previous'),
	v.literal('back-to-list'),
);

// Postbox default reply behavior (mailUserSettings.replyDefault and mail/settings
// update args) — whether the primary reply affordance / `r` opens a plain Reply
// or a Reply-all. Single source so schema and args can't drift.
export const mailReplyDefaultValidator = v.union(
	v.literal('reply'),
	v.literal('reply-all'),
);

// Email template kind (emailTemplates.type and its CRUD args)
export const emailTemplateTypeValidator = v.union(
	v.literal('marketing'),
	v.literal('transactional'),
);

// Attachment metadata embedded in raw .eml (mailMessages.attachments)
export const mailMessageAttachmentValidator = v.object({
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	contentId: v.optional(v.string()),
	partIndex: v.string(),
});

// Parsed List-Unsubscribe / List-Unsubscribe-Post target (mailMessages.unsubscribe).
// Parsed ONCE at ingest from the raw header block (see @owlat/shared/listUnsubscribe)
// so the reader can render the Unsubscribe chip without re-opening the raw .eml.
export const mailUnsubscribeValidator = v.object({
	httpUrl: v.optional(v.string()),
	mailtoUrl: v.optional(v.string()),
	oneClick: v.boolean(),
});

// Compose-draft attachment referencing Convex storage (mailDrafts.attachments)
export const mailDraftAttachmentValidator = v.object({
	storageId: v.id('_storage'),
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	isInline: v.boolean(),
	contentId: v.optional(v.string()),
});

// LLM call accounting (agentActions.tokenUsage and similar)
export const tokenUsageValidator = v.object({
	promptTokens: v.number(),
	completionTokens: v.number(),
	totalTokens: v.number(),
});

// ─── AI assistant / chat conversation (shared) ──────────────────────────────
// Streaming lifecycle of one assistant turn (aiMessages.status + the chatMessages
// `aiStatus` field for @assistant replies). `streaming` rows are patched in place
// as tokens arrive; `complete`/`stopped`/`error` are terminal.
export const assistantMessageStatusValidator = v.union(
	v.literal('streaming'),
	v.literal('complete'),
	v.literal('stopped'),
	v.literal('error'),
);

// One entry in the tool-call transcript an assistant turn produces (aiMessages
// and chatMessages `toolCalls`). `argsJson` / `resultJson` are display-only,
// JSON-encoded for the tool-call UI cards — they are NEVER replayed into the
// model context (each turn replays only prior final assistant text), so no
// `<field>Version` sibling is needed: no reader ever branches on their shape.
export const assistantToolCallValidator = v.object({
	toolCallId: v.string(),
	toolName: v.string(),
	argsJson: v.optional(v.string()),
	resultJson: v.optional(v.string()),
	status: v.union(v.literal('running'), v.literal('done'), v.literal('error')),
});

// Inbound message security scan results (inboundMessages.securityFlags)
export const securityFlagsValidator = v.object({
	injectionDetected: v.boolean(),
	injectionType: v.optional(v.string()),
	confidence: v.number(),
	flaggedContent: v.optional(v.string()),
	spamScore: v.optional(v.number()),
	phishingDetected: v.optional(v.boolean()),
	// True when the guard-tier LLM injection classifier could not run (model
	// error / empty sample). The pipeline still proceeds to a draft (fail open),
	// but the route step refuses to AUTO-SEND without a clean guard pass
	// (fail closed on the auto-send path only).
	guardUnavailable: v.optional(v.boolean()),
	scanTimestamp: v.number(),
});

// Agent classification output (inboundMessages.classification)
export const classificationValidator = v.object({
	category: v.string(),
	priority: v.string(),
	sentiment: v.string(),
	intent: v.string(),
	confidence: v.number(),
});

// Content scan flag (contentScanResults.flags array entry).
// Mirrors @owlat/email-scanner ContentFlag — keep in sync when that type changes.
export const contentScanFlagValidator = v.object({
	type: v.string(), // ContentFlagType union (kept open to avoid coupling to package)
	severity: v.union(v.literal('low'), v.literal('medium'), v.literal('high')),
	description: v.string(),
	match: v.optional(v.string()),
});

// Audit log action and resource literal unions — derived from the single
// catalog in `auditActions/catalog.ts`. Re-exported here so existing
// `lib/validators` and `lib/auditLog` consumers keep their import path.
export {
	auditActionValidator,
	auditResourceValidator,
} from '../auditActions/catalog';
