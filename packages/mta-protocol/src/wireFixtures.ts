/**
 * FROZEN WIRE FIXTURES — the bytes, exactly as they crossed before D7.
 *
 * Test-only, but declared here rather than in a `__tests__` folder for one
 * reason: it is the only place BOTH apps can import ONE copy from. The whole
 * risk this package carries is that extracting the contract into shared types
 * lets TypeScript narrowing quietly re-shape what is serialized; a fixture each
 * suite kept its own copy of would drift with the code it was meant to catch.
 *
 * TWO GATES HOLD THE FIXTURES TO THE CONTRACT, and they catch different things.
 *
 * 1. TYPE, at compile time. Every fixture below is a typed literal put through
 *    `JSON.stringify`, and each literal is `satisfies`-checked against the wire
 *    declaration it claims to be. Rename `dkimDomain` in `MtaSendRequest`, drop
 *    a code from `MTA_SEND_ERROR_CODES`, add a reason to
 *    `MTA_RELAY_DECISION_REASONS` — and `tsc` fails HERE, before any suite runs.
 *    (The decision fixtures go further: their `Record<…Reason, string>`
 *    annotations make a new reason a missing-property error, so the union cannot
 *    grow a member nobody wrote bytes for.)
 *
 * 2. CODE, at run time, in the two apps. `apps/mta`'s suite drives the SHIPPED
 *    `/send`, `/send/decision` and `/ip-reputation` handlers and asserts their
 *    raw response text equals these bytes; `apps/api`'s suite drives the shipped
 *    adapter and asserts the request bytes it hands `fetch` and the answers it
 *    resolves. That is what pins the CODE, which no type can.
 *
 * The one leg without a producer-side driver is the webhook events: those are
 * emitted from a dozen sites across the MTA's delivery path rather than from one
 * handler. They are pinned at both ends of what matters — the type above, and
 * `isMtaWebhookEvent` (the Convex ingress that actually decides) in both suites.
 *
 * Every fixture is a STRING, never an object: the bytes are the contract, key
 * order included, and `JSON.stringify` walks each literal's own key order.
 */

import {
	type MtaDeferReason,
	type MtaRelayDecisionReason,
	type MtaRoutingDecisionResponse,
} from './routingDecision';
import type { MtaSendAccepted, MtaSendRefused, MtaSendRequest } from './send';
import type { ValidatedMtaWebhookEvent } from './webhookEventShape';

/**
 * The one instant every fixture is stamped with. Shared so a test that fakes
 * the clock to it reproduces the timestamps the fixtures carry.
 */
export const WIRE_FIXTURE_NOW = 1_750_000_000_000;

/** The UTC day {@link WIRE_FIXTURE_NOW} falls on — the snapshot's `date`. */
export const WIRE_FIXTURE_DATE = '2025-06-15';

/** A governed `/send` body, every optional field populated so none is dropped. */
export const GOVERNED_SEND_REQUEST_BYTES = JSON.stringify({
	messageId: 'send-fixture-1',
	workAttemptId: 'work-fixture-1',
	routingReentryToken: 'reentry-fixture-1',
	routingReentry: {
		envelopeInput: { campaignId: 'cmp-1' },
		retryState: { attempt: 2, startedAt: WIRE_FIXTURE_NOW, idempotencyKey: 'send-fixture-1' },
	},
	to: 'recipient@example.com',
	from: 'Owlat <sender@mail.example.org>',
	subject: 'Wire fixture',
	html: '<p>hi</p>',
	text: 'hi',
	replyTo: 'reply@example.org',
	headers: { 'X-Owlat-Fixture': '1' },
	ipPool: 'campaign',
	engagementScore: 73,
	dkimDomain: 'mail.example.org',
	organizationId: 'org-fixture-1',
	messageType: 'campaign',
	deliveryDomain: 'production',
	routingLease: 'lease-fixture-1',
	allowWarmupOverflow: true,
} satisfies MtaSendRequest);

/** The `/send/system` body — three constants and the caller's idempotency key. */
export const SYSTEM_SEND_REQUEST_BYTES = JSON.stringify({
	messageId: 'system-fixture-1',
	to: 'person@example.com',
	from: 'Owlat <noreply@mail.example.org>',
	subject: 'Reset your password',
	html: '<p>reset</p>',
	ipPool: 'transactional',
	dkimDomain: 'mail.example.org',
	organizationId: 'system',
} satisfies MtaSendRequest);

/** Accepted, queued now — `id` is the caller's messageId, never the queue id. */
export const SEND_ACCEPTED_BYTES = JSON.stringify({
	success: true,
	id: 'send-fixture-1',
	workAttemptId: 'work-fixture-1',
} satisfies MtaSendAccepted);

/** Accepted earlier — the durable intake receipt already said so. */
export const SEND_DEDUPLICATED_BYTES = JSON.stringify({
	success: true,
	id: 'send-fixture-1',
	deduplicated: true,
} satisfies MtaSendAccepted);

/** Refused while another attempt holds the intake reservation. */
export const SEND_INTAKE_PENDING_BYTES = JSON.stringify({
	error: 'Intake reservation is still pending',
	code: 'INTAKE_PENDING',
	retryAfterMs: 1000,
} satisfies MtaSendRefused);

/** Refused because the governed path arrived without a current routing lease. */
export const SEND_LEASE_REQUIRED_BYTES = JSON.stringify({
	error: 'A current routing lease is required',
	code: 'ROUTING_LEASE_REQUIRED',
} satisfies MtaSendRefused);

/** The `mta` decision: an authenticated last-mile lease. */
export const DECISION_MTA_BYTES = JSON.stringify({
	decision: 'mta',
	lease: { token: 'lease-fixture-1', providerProbe: false, globalProbe: false },
} satisfies MtaRoutingDecisionResponse);

/** The reason-less `relay` decision — the answer to a relay candidate. */
export const DECISION_RELAY_ALLOWED_BYTES = JSON.stringify({
	decision: 'relay',
} satisfies MtaRoutingDecisionResponse);

/**
 * Every `relay` decision that names a provider-local condition. The `Record`
 * annotation is the gate: a reason added to `MTA_RELAY_DECISION_REASONS` is a
 * missing property here until somebody writes its bytes.
 */
export const DECISION_RELAY_REASON_BYTES: Record<MtaRelayDecisionReason, string> = {
	provider_breaker: JSON.stringify({
		decision: 'relay',
		reason: 'provider_breaker',
	} satisfies MtaRoutingDecisionResponse),
	provider_probe_limit: JSON.stringify({
		decision: 'relay',
		reason: 'provider_probe_limit',
	} satisfies MtaRoutingDecisionResponse),
	provider_hysteresis: JSON.stringify({
		decision: 'relay',
		reason: 'provider_hysteresis',
	} satisfies MtaRoutingDecisionResponse),
	warmup_overflow: JSON.stringify({
		decision: 'relay',
		reason: 'warmup_overflow',
	} satisfies MtaRoutingDecisionResponse),
};

/** Every `defer` decision, one per reason in `MTA_DEFER_REASON_ORIGIN`. */
export const DECISION_DEFER_BYTES: Record<MtaDeferReason, string> = {
	global_safety: JSON.stringify({
		decision: 'defer',
		reason: 'global_safety',
		retryAfterMs: 60000,
	} satisfies MtaRoutingDecisionResponse),
	global_probe: JSON.stringify({
		decision: 'defer',
		reason: 'global_probe',
		retryAfterMs: 60000,
	} satisfies MtaRoutingDecisionResponse),
	no_owned_ip: JSON.stringify({
		decision: 'defer',
		reason: 'no_owned_ip',
		retryAfterMs: 60000,
	} satisfies MtaRoutingDecisionResponse),
	lease_persistence: JSON.stringify({
		decision: 'defer',
		reason: 'lease_persistence',
		retryAfterMs: 60000,
	} satisfies MtaRoutingDecisionResponse),
};

/** One webhook event per shape the two ends most disagree about. */
export const WEBHOOK_EVENT_BYTES = {
	sent: JSON.stringify({
		event: 'sent',
		messageId: 'send-fixture-1',
		timestamp: WIRE_FIXTURE_NOW,
	} satisfies ValidatedMtaWebhookEvent),
	bounced: JSON.stringify({
		event: 'bounced',
		messageId: 'send-fixture-1',
		recipient: 'recipient@example.com',
		bounceType: 'hard',
		timestamp: WIRE_FIXTURE_NOW,
	} satisfies ValidatedMtaWebhookEvent),
	complained: JSON.stringify({
		event: 'complained',
		messageId: 'send-fixture-1',
		recipient: 'recipient@example.com',
		reportedDomain: 'mail.example.org',
		sourceIsp: 'yahoo',
		timestamp: WIRE_FIXTURE_NOW,
	} satisfies ValidatedMtaWebhookEvent),
	'routing.reentry': JSON.stringify({
		event: 'routing.reentry',
		messageId: 'send-fixture-1',
		routingReentryToken: 'reentry-fixture-1',
		workAttemptId: 'work-fixture-1',
		routingReentry: {
			envelopeInput: { campaignId: 'cmp-1' },
			retryState: { attempt: 2, startedAt: WIRE_FIXTURE_NOW, idempotencyKey: 'send-fixture-1' },
		},
		routingReentryReason: 'routing_lease_stale',
		timestamp: WIRE_FIXTURE_NOW,
	} satisfies ValidatedMtaWebhookEvent),
	'postmaster.stats': JSON.stringify({
		event: 'postmaster.stats',
		domain: 'mail.example.org',
		date: '2026-08-06',
		userReportedSpamRatio: 0.001,
		spfSuccessRatio: 1,
		deliveryErrors: [{ category: 'RATE_LIMIT_EXCEEDED', ratio: 0.02 }],
		timestamp: WIRE_FIXTURE_NOW,
	} satisfies ValidatedMtaWebhookEvent),
	'postmaster.compliance': JSON.stringify({
		event: 'postmaster.compliance',
		domain: 'mail.example.org',
		date: '2026-08-06',
		checks: [{ name: 'SPF_ALIGNMENT', state: 'passing' }],
		timestamp: WIRE_FIXTURE_NOW,
	} satisfies ValidatedMtaWebhookEvent),
};

/**
 * The `GET /ip-reputation` snapshot, exactly as `createIpReputationRoutes`
 * serialises it.
 *
 * The one fixture with no `satisfies`, and deliberately so: the producer is
 * WIDER than the consumer's `MtaIpReputationPayload` (it also carries
 * `delivered`, `bounceRate`, `dnsblUnmeasured` and the `routing` block, which
 * the warming sync does not read) and weaker in two places (`dnsbl` and
 * `warmingPhase` are plain strings there). Annotating it against either half
 * would be a lie. Both halves are pinned by CODE instead — the producer by
 * `apps/mta/src/routes/__tests__/wireCompat.test.ts`, the consumer by
 * `normalizeIpReputationPayload` in this package's suite and in `apps/api`'s.
 */
export const IP_REPUTATION_SNAPSHOT_BYTES = `{"date":"${WIRE_FIXTURE_DATE}","ips":[{"ip":"192.0.2.10","sent":400,"delivered":390,"bounced":4,"deferred":6,"bounceRate":1,"warmingPhase":"ramp","warmingDay":5,"pool":"campaign","active":true,"blockReasons":[],"fcrdns":null,"ipv6Spf":null,"sourceAddress":null,"dnsbl":"clean","dnsblListings":[],"dnsblUnmeasured":false,"dnsblCheckedAt":${WIRE_FIXTURE_NOW}}],"routing":{"generatedAt":${WIRE_FIXTURE_NOW},"signals":[]}}`;
