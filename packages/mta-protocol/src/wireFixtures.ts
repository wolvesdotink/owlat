/**
 * FROZEN WIRE FIXTURES — the bytes, exactly as they crossed before D7.
 *
 * Test-only, but declared here rather than in a `__tests__` folder for one
 * reason: it is the only place BOTH apps can import ONE copy from. The whole
 * risk this package carries is that extracting the contract into shared types
 * lets TypeScript narrowing quietly re-shape what is serialized; a fixture each
 * suite kept its own copy of would drift with the code it was meant to catch.
 * "Test-only" is therefore enforced, not just stated: importing the
 * `@owlat/mta-protocol/wireFixtures` subpath outside a `__tests__/` folder fails
 * `scripts/check-cross-package-imports.sh`.
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
 *    `/send`, `/send/postbox`, `/send/decision` and `/ip-reputation` handlers
 *    and asserts their raw response text equals these bytes; `apps/api`'s suite
 *    drives the shipped adapter and the exported forward producer and asserts
 *    the request bytes they hand `fetch` and the answers they resolve. That is
 *    what pins the CODE, which no type can.
 *
 * Two legs have no full producer-side driver, and each is pinned at both ends of
 * what matters instead. The webhook events are emitted from a dozen sites across
 * the MTA's delivery path rather than from one handler — the type above, and
 * `isMtaWebhookEvent` (the Convex ingress that actually decides) in both suites.
 * The Postbox send and vacation auto-reply are Convex actions with a database
 * behind them — the type, the forward producer next to them (same body, same
 * fixture), and `apps/mta`'s postbox intake driven with these bytes.
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

/**
 * The UTC day {@link WIRE_FIXTURE_NOW} falls on, and the `date` of every
 * fixture that carries one — the IP-reputation snapshot and both Postmaster
 * events. Derived rather than written out so no fixture can state an impossible
 * event: a daily observation stamped with a `timestamp` on a different day is
 * not a thing the MTA ever emits, and `delivery/postmaster.ts` buckets by UTC
 * day, so a coherence check added there must find these bytes coherent.
 */
export const WIRE_FIXTURE_DATE = new Date(WIRE_FIXTURE_NOW).toISOString().slice(0, 10);

/**
 * A governed `/send` body, with every optional field the governed adapter can
 * emit populated so none is dropped.
 *
 * NOT the whole of `MtaSendRequest`: `sealedMimeBase64`, `amp` and
 * `allowedFromAddresses` are set by the Postbox producers only, and are covered
 * by {@link POSTBOX_SEND_REQUEST_BYTES} below.
 */
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

/**
 * A Postbox `/send/postbox` body, unsealed — the branch `mail/outbound.ts`
 * takes when the draft is not end-to-end encrypted, in that literal's key
 * order.
 *
 * The Postbox leg carries three fields no other producer sets, and each is
 * load-bearing in a way a missing field is not: `amp` is a whole alternative
 * part, `allowedFromAddresses` is the ONLY place the MTA itself enforces From
 * ownership (a rename refuses every personal-mailbox send 403), and
 * `sealedMimeBase64` below is the ciphertext itself.
 */
export const POSTBOX_SEND_REQUEST_BYTES = JSON.stringify({
	messageId: 'pb-fixture-1',
	from: 'Owlat <postbox@mail.example.org>',
	to: 'recipient@example.com',
	subject: 'Postbox wire fixture',
	html: '<p>hi</p>',
	text: 'hi',
	amp: '<html amp4email><body>hi</body></html>',
	headers: { 'Message-ID': '<pb-fixture-1@mail.example.org>' },
	ipPool: 'transactional',
	organizationId: 'postbox',
	dkimDomain: 'mail.example.org',
	allowedFromAddresses: ['postbox@mail.example.org'],
} satisfies MtaSendRequest);

/**
 * The base64 PGP/MIME envelope {@link POSTBOX_SEALED_SEND_REQUEST_BYTES}
 * carries. Written out rather than computed so the fixture stays bytes, and
 * because the intake authorizes it structurally: its `From` must match the
 * request's, its `Subject` must be the placeholder `...`, and its
 * `Content-Type` must be `multipart/encrypted` with the PGP protocol
 * parameter. Decoded, with CRLF line endings:
 *
 * ```
 * From: Owlat <postbox@mail.example.org>
 * To: recipient@example.com
 * Subject: ...
 * MIME-Version: 1.0
 * Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="owlat-seal"
 *
 * --owlat-seal
 * Content-Type: application/pgp-encrypted
 *
 * Version: 1
 *
 * --owlat-seal
 * Content-Type: application/octet-stream
 *
 * -----BEGIN PGP MESSAGE-----
 *
 * ZmFrZS1jaXBoZXJ0ZXh0
 * -----END PGP MESSAGE-----
 *
 * --owlat-seal--
 * ```
 */
export const SEALED_MIME_BASE64 =
	'RnJvbTogT3dsYXQgPHBvc3Rib3hAbWFpbC5leGFtcGxlLm9yZz4NClRvOiByZWNpcGllbnRAZXhhbXBsZS5jb20NClN1YmplY3Q6IC4uLg0KTUlNRS1WZXJzaW9uOiAxLjANCkNvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L2VuY3J5cHRlZDsgcHJvdG9jb2w9ImFwcGxpY2F0aW9uL3BncC1lbmNyeXB0ZWQiOyBib3VuZGFyeT0ib3dsYXQtc2VhbCINCg0KLS1vd2xhdC1zZWFsDQpDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL3BncC1lbmNyeXB0ZWQNCg0KVmVyc2lvbjogMQ0KDQotLW93bGF0LXNlYWwNCkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtDQoNCi0tLS0tQkVHSU4gUEdQIE1FU1NBR0UtLS0tLQ0KDQpabUZyWlMxamFYQm9aWEowWlhoMA0KLS0tLS1FTkQgUEdQIE1FU1NBR0UtLS0tLQ0KDQotLW93bGF0LXNlYWwtLQ0K';

/**
 * The sealed Postbox body — `mail/outbound.ts`'s other branch, where the
 * structured fields are a placeholder (`html: ' '`) and the whole message is
 * the PGP/MIME envelope.
 */
export const POSTBOX_SEALED_SEND_REQUEST_BYTES = JSON.stringify({
	messageId: 'pb-fixture-2',
	from: 'Owlat <postbox@mail.example.org>',
	to: 'recipient@example.com',
	subject: '...',
	html: ' ',
	sealedMimeBase64: SEALED_MIME_BASE64,
	headers: { 'Message-ID': '<pb-fixture-2@mail.example.org>' },
	ipPool: 'transactional',
	organizationId: 'postbox',
	dkimDomain: 'mail.example.org',
	allowedFromAddresses: ['postbox@mail.example.org'],
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
		date: WIRE_FIXTURE_DATE,
		userReportedSpamRatio: 0.001,
		spfSuccessRatio: 1,
		deliveryErrors: [{ category: 'RATE_LIMIT_EXCEEDED', ratio: 0.02 }],
		timestamp: WIRE_FIXTURE_NOW,
	} satisfies ValidatedMtaWebhookEvent),
	'postmaster.compliance': JSON.stringify({
		event: 'postmaster.compliance',
		domain: 'mail.example.org',
		date: WIRE_FIXTURE_DATE,
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
