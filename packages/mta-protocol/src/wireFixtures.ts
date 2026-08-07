/**
 * FROZEN WIRE FIXTURES — the bytes, exactly as they crossed before D7.
 *
 * Test-only, but declared here rather than in a `__tests__` folder for one
 * reason: it is the only place BOTH apps can import ONE copy from. The whole
 * risk this package carries is that extracting the contract into shared types
 * lets TypeScript narrowing quietly re-shape what is serialized; a fixture each
 * suite kept its own copy of would drift with the code it was meant to catch.
 *
 * So: `apps/mta`'s suite asserts its handlers PRODUCE these bytes and ACCEPT
 * the ones Convex sends, `apps/api`'s suite asserts its adapter produces the
 * request bytes and resolves these answers, and this package's own suite
 * asserts every fixture is exactly what the types say it is. Change a byte here
 * and three suites in two apps disagree with you at once.
 *
 * Every fixture is a STRING, never an object literal: the bytes are the
 * contract, key order included.
 */

/** A governed `/send` body, every optional field populated so none is dropped. */
export const GOVERNED_SEND_REQUEST_BYTES =
	'{"messageId":"send-fixture-1","workAttemptId":"work-fixture-1","routingReentryToken":"reentry-fixture-1","routingReentry":{"envelopeInput":{"campaignId":"cmp-1"},"retryState":{"attempt":2,"startedAt":1750000000000,"idempotencyKey":"send-fixture-1"}},"to":"recipient@example.com","from":"Owlat <sender@mail.example.org>","subject":"Wire fixture","html":"<p>hi</p>","text":"hi","replyTo":"reply@example.org","headers":{"X-Owlat-Fixture":"1"},"ipPool":"campaign","engagementScore":73,"dkimDomain":"mail.example.org","organizationId":"org-fixture-1","messageType":"campaign","deliveryDomain":"production","routingLease":"lease-fixture-1","allowWarmupOverflow":true}';

/** The `/send/system` body — three constants and the caller's idempotency key. */
export const SYSTEM_SEND_REQUEST_BYTES =
	'{"messageId":"system-fixture-1","to":"person@example.com","from":"Owlat <noreply@mail.example.org>","subject":"Reset your password","html":"<p>reset</p>","ipPool":"transactional","dkimDomain":"mail.example.org","organizationId":"system"}';

/** Accepted, queued now — `id` is the caller's messageId, never the queue id. */
export const SEND_ACCEPTED_BYTES =
	'{"success":true,"id":"send-fixture-1","workAttemptId":"work-fixture-1"}';

/** Accepted earlier — the durable intake receipt already said so. */
export const SEND_DEDUPLICATED_BYTES = '{"success":true,"id":"send-fixture-1","deduplicated":true}';

/** Refused while another attempt holds the intake reservation. */
export const SEND_INTAKE_PENDING_BYTES =
	'{"error":"Intake reservation is still pending","code":"INTAKE_PENDING","retryAfterMs":1000}';

/** Refused because the governed path arrived without a current routing lease. */
export const SEND_LEASE_REQUIRED_BYTES =
	'{"error":"A current routing lease is required","code":"ROUTING_LEASE_REQUIRED"}';

/** The `mta` decision: an authenticated last-mile lease. */
export const DECISION_MTA_BYTES =
	'{"decision":"mta","lease":{"token":"lease-fixture-1","providerProbe":false,"globalProbe":false}}';

/** The reason-less `relay` decision — the answer to a relay candidate. */
export const DECISION_RELAY_ALLOWED_BYTES = '{"decision":"relay"}';

/** Every `relay` decision that names a provider-local condition. */
export const DECISION_RELAY_REASON_BYTES = {
	provider_breaker: '{"decision":"relay","reason":"provider_breaker"}',
	provider_probe_limit: '{"decision":"relay","reason":"provider_probe_limit"}',
	provider_hysteresis: '{"decision":"relay","reason":"provider_hysteresis"}',
	warmup_overflow: '{"decision":"relay","reason":"warmup_overflow"}',
} as const;

/** Every `defer` decision, one per reason in `MTA_DEFER_REASON_ORIGIN`. */
export const DECISION_DEFER_BYTES = {
	global_safety: '{"decision":"defer","reason":"global_safety","retryAfterMs":60000}',
	global_probe: '{"decision":"defer","reason":"global_probe","retryAfterMs":60000}',
	no_owned_ip: '{"decision":"defer","reason":"no_owned_ip","retryAfterMs":60000}',
	lease_persistence: '{"decision":"defer","reason":"lease_persistence","retryAfterMs":60000}',
} as const;

/** One webhook event per shape the two ends most disagree about. */
export const WEBHOOK_EVENT_BYTES = {
	sent: '{"event":"sent","messageId":"send-fixture-1","timestamp":1750000000000}',
	bounced:
		'{"event":"bounced","messageId":"send-fixture-1","recipient":"recipient@example.com","bounceType":"hard","timestamp":1750000000000}',
	complained:
		'{"event":"complained","messageId":"send-fixture-1","recipient":"recipient@example.com","reportedDomain":"mail.example.org","sourceIsp":"yahoo","timestamp":1750000000000}',
	'routing.reentry':
		'{"event":"routing.reentry","messageId":"send-fixture-1","routingReentryToken":"reentry-fixture-1","workAttemptId":"work-fixture-1","routingReentry":{"envelopeInput":{"campaignId":"cmp-1"},"retryState":{"attempt":2,"startedAt":1750000000000,"idempotencyKey":"send-fixture-1"}},"routingReentryReason":"routing_lease_stale","timestamp":1750000000000}',
	'postmaster.stats':
		'{"event":"postmaster.stats","domain":"mail.example.org","date":"2026-08-06","userReportedSpamRatio":0.001,"spfSuccessRatio":1,"deliveryErrors":[{"category":"RATE_LIMIT_EXCEEDED","ratio":0.02}],"timestamp":1750000000000}',
	'postmaster.compliance':
		'{"event":"postmaster.compliance","domain":"mail.example.org","date":"2026-08-06","checks":[{"name":"SPF_ALIGNMENT","state":"passing"}],"timestamp":1750000000000}',
} as const;

/** The `GET /ip-reputation` snapshot, with the fields the consumer reads. */
export const IP_REPUTATION_SNAPSHOT_BYTES =
	'{"date":"2026-08-06","ips":[{"ip":"192.0.2.10","sent":400,"delivered":390,"bounced":4,"deferred":6,"bounceRate":1,"warmingPhase":"ramp","warmingDay":5,"pool":"campaign","active":true,"blockReasons":[],"fcrdns":null,"ipv6Spf":null,"sourceAddress":null,"dnsbl":"clean","dnsblListings":[],"dnsblUnmeasured":false,"dnsblCheckedAt":1750000000000}],"routing":{"generatedAt":1750000000000,"signals":[]}}';
