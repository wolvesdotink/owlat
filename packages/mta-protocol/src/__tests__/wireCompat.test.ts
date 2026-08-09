/**
 * Wire-compat: the frozen fixtures are canonical, and mean what they claim.
 *
 * The TYPE half of this gate is not here — it is in `wireFixtures.ts` itself,
 * where every fixture is a typed literal `satisfies`-checked against its wire
 * declaration and serialized. A field renamed or dropped by the declaration
 * fails `tsc` before this suite runs, which is the earliest anything can catch
 * it. What runs HERE is what a type cannot state: that each fixture is
 * canonical JSON (so byte comparison against a live handler is meaningful),
 * that the reason tables and their fixtures cover each other exactly, and that
 * every fixture passes the runtime guard its consumer actually applies.
 *
 * The two apps' halves live in
 * `apps/mta/src/routes/__tests__/wireCompat.test.ts` (the handlers produce and
 * accept these bytes) and
 * `apps/api/convex/lib/sendProviders/__tests__/mtaWireCompat.test.ts` (the
 * adapter produces and resolves them). All three read this one fixture module.
 */

import { describe, expect, it } from 'vitest';
import {
	MTA_DEFER_REASON_ORIGIN,
	MTA_RELAY_DECISION_REASONS,
	isMtaRelayDecisionReason,
	mtaDeferReasonOrigin,
	type MtaDeferReason,
	type MtaRoutingDecisionResponse,
} from '../routingDecision';
import { ROUTING_LEASE_UNREADABLE_CODE } from '@owlat/shared/routingDispatch';
import {
	MTA_SEND_ERROR_CODES,
	isMtaSendErrorCode,
	type MtaSendRequest,
	type MtaSendResponse,
} from '../send';
import {
	isMtaWebhookEvent,
	MTA_WEBHOOK_EVENT_TYPES,
	type ValidatedMtaWebhookEvent,
} from '../webhookEvent';
import { normalizeIpReputationPayload } from '../ipReputation';
import {
	DECISION_DEFER_BYTES,
	DECISION_MTA_BYTES,
	DECISION_RELAY_ALLOWED_BYTES,
	DECISION_RELAY_REASON_BYTES,
	GOVERNED_SEND_REQUEST_BYTES,
	IP_REPUTATION_SNAPSHOT_BYTES,
	SEND_ACCEPTED_BYTES,
	SEND_DEDUPLICATED_BYTES,
	SEND_INTAKE_PENDING_BYTES,
	SEND_LEASE_REQUIRED_BYTES,
	SYSTEM_SEND_REQUEST_BYTES,
	WEBHOOK_EVENT_BYTES,
} from '../wireFixtures';

/**
 * Assert the fixture is CANONICAL JSON and hand it back parsed.
 *
 * Not a type check — `JSON.parse … as T` erases, and asserting `stringify` over
 * `parse` would hold for any canonical string no matter what the declarations
 * say. `wireFixtures.ts` does the type half at compile time. What this buys is
 * the premise the apps' suites rest on: no insignificant whitespace, no
 * `1.0`-for-`1`, no escape the re-serialization would normalize away — so
 * `expect(await response.text()).toBe(FIXTURE)` over there is a real
 * byte-for-byte comparison rather than a lucky one.
 */
function canonical<T>(bytes: string): T {
	const parsed = JSON.parse(bytes) as T;
	expect(JSON.stringify(parsed)).toBe(bytes);
	return parsed;
}

describe('send intake wire', () => {
	it('carries a governed request byte-identically', () => {
		const request = canonical<MtaSendRequest>(GOVERNED_SEND_REQUEST_BYTES);
		expect(request.messageId).toBe('send-fixture-1');
		expect(request.ipPool).toBe('campaign');
		// Carried, never re-derived: the callback digest is taken over exactly
		// these bytes, so the re-entry snapshot must survive the round trip whole.
		expect(request.routingReentry?.retryState.idempotencyKey).toBe(request.messageId);
	});

	it('carries a system request byte-identically', () => {
		const request = canonical<MtaSendRequest>(SYSTEM_SEND_REQUEST_BYTES);
		expect(request.organizationId).toBe('system');
		expect(request.ipPool).toBe('transactional');
		// The system intake refuses tenant routing material outright.
		expect(request.routingLease).toBeUndefined();
		expect(request.workAttemptId).toBeUndefined();
	});

	it.each([
		['accepted', SEND_ACCEPTED_BYTES],
		['deduplicated', SEND_DEDUPLICATED_BYTES],
		['intake pending', SEND_INTAKE_PENDING_BYTES],
		['lease required', SEND_LEASE_REQUIRED_BYTES],
	])('carries the %s response byte-identically', (_label, bytes) => {
		canonical<MtaSendResponse>(bytes);
	});

	// The doc on `MTA_SEND_ERROR_CODES` says EVERY code the intake attaches to a
	// refusal, and `ROUTING_LEASE_UNREADABLE` was missing from it while being on
	// the wire — which is exactly the gap that let one 409 be answered outside the
	// typed helper. Pinned against the SHARED constant, not a literal: that string
	// is matched by substring on the Convex side, where a second spelling of it
	// fails silently.
	it('declares the lease-unreadable code the MTA actually answers', () => {
		expect(MTA_SEND_ERROR_CODES).toContain(ROUTING_LEASE_UNREADABLE_CODE);
		expect(isMtaSendErrorCode(ROUTING_LEASE_UNREADABLE_CODE)).toBe(true);
	});

	it('keeps `id` the caller’s message id and the queue identity separate', () => {
		const accepted = canonical<MtaSendResponse>(SEND_ACCEPTED_BYTES);
		const request = JSON.parse(GOVERNED_SEND_REQUEST_BYTES) as MtaSendRequest;
		expect('success' in accepted && accepted.id).toBe(request.messageId);
		expect('success' in accepted && accepted.workAttemptId).toBe(request.workAttemptId);
	});
});

describe('routing decision wire', () => {
	it('carries the mta decision byte-identically', () => {
		const decision = canonical<MtaRoutingDecisionResponse>(DECISION_MTA_BYTES);
		expect(decision.decision).toBe('mta');
		// Convex validates this answer by EXACT key count (2 outer, 3 in the lease).
		expect(Object.keys(decision)).toHaveLength(2);
		expect(Object.keys((decision as { lease: object }).lease)).toEqual([
			'token',
			'providerProbe',
			'globalProbe',
		]);
	});

	it('carries the reason-less relay decision byte-identically', () => {
		const decision = canonical<MtaRoutingDecisionResponse>(DECISION_RELAY_ALLOWED_BYTES);
		expect(Object.keys(decision)).toEqual(['decision']);
	});

	it('has a fixture for every relay reason, and no reason without one', () => {
		expect(Object.keys(DECISION_RELAY_REASON_BYTES).sort()).toEqual(
			[...MTA_RELAY_DECISION_REASONS].sort()
		);
	});

	it.each(Object.entries(DECISION_RELAY_REASON_BYTES))(
		'carries the %s relay decision byte-identically',
		(reason, bytes) => {
			const decision = canonical<MtaRoutingDecisionResponse>(bytes);
			expect(decision).toEqual({ decision: 'relay', reason });
		}
	);

	it('recognises exactly the relay reasons the one list names', () => {
		// Convex's validator accepts a relay answer through THIS guard. A reason
		// the emitter may legally send but the guard does not know falls through
		// to the unrecognised-answer branch and silently becomes a 60-second
		// defer, so the two must be the same list — not two copies of it.
		for (const reason of MTA_RELAY_DECISION_REASONS) {
			expect(isMtaRelayDecisionReason(reason)).toBe(true);
		}
		expect(isMtaRelayDecisionReason('provider_pool_exhausted')).toBe(false);
		expect(isMtaRelayDecisionReason('constructor')).toBe(false);
		expect(isMtaRelayDecisionReason('__proto__')).toBe(false);
		expect(isMtaRelayDecisionReason(undefined)).toBe(false);
	});

	it('has a fixture for every defer reason, and no reason without one', () => {
		expect(Object.keys(DECISION_DEFER_BYTES).sort()).toEqual(
			Object.keys(MTA_DEFER_REASON_ORIGIN).sort()
		);
	});

	it.each(Object.entries(DECISION_DEFER_BYTES))(
		'carries the %s defer decision byte-identically and classifies its origin',
		(reason, bytes) => {
			const decision = canonical<MtaRoutingDecisionResponse>(bytes);
			expect(Object.keys(decision)).toEqual(['decision', 'reason', 'retryAfterMs']);
			expect(mtaDeferReasonOrigin(reason)).toBe(MTA_DEFER_REASON_ORIGIN[reason as MtaDeferReason]);
		}
	);

	it('refuses to classify a reason nobody vouched for', () => {
		// A reason invented on the MTA side lands here and stops being counted
		// until it is added to the table with an origin beside it.
		expect(mtaDeferReasonOrigin('brand_new_reason')).toBeUndefined();
		// And an inherited key is not a vouched reason either.
		expect(mtaDeferReasonOrigin('constructor')).toBeUndefined();
		expect(mtaDeferReasonOrigin('__proto__')).toBeUndefined();
		expect(mtaDeferReasonOrigin(undefined)).toBeUndefined();
	});

	it('classifies our own storage failing as local, never as the identity’s standing', () => {
		// Gate 2 halts a cell at 25% of GOVERNED deferrals; a Redis outage on our
		// own MTA must not be able to spend that budget.
		expect(mtaDeferReasonOrigin('lease_persistence')).toBe('local');
		expect(mtaDeferReasonOrigin('global_safety')).toBe('governed');
		expect(mtaDeferReasonOrigin('global_probe')).toBe('governed');
		expect(mtaDeferReasonOrigin('no_owned_ip')).toBe('governed');
	});
});

describe('webhook event wire', () => {
	it.each(Object.entries(WEBHOOK_EVENT_BYTES))(
		'carries the %s event byte-identically and past the ingress guard',
		(event, bytes) => {
			const parsed = canonical<ValidatedMtaWebhookEvent>(bytes);
			expect(parsed.event).toBe(event);
			expect(isMtaWebhookEvent(parsed)).toBe(true);
		}
	);

	it('only fixtures event types the contract declares', () => {
		for (const event of Object.keys(WEBHOOK_EVENT_BYTES)) {
			expect(MTA_WEBHOOK_EVENT_TYPES).toContain(event);
		}
	});

	it('keeps the FBL-only fields on the complaint event', () => {
		const complaint = JSON.parse(WEBHOOK_EVENT_BYTES.complained) as ValidatedMtaWebhookEvent;
		// `sourceIsp` is the destination-provider union, not a free string: a
		// consumer comparing it to 'yahoo' compares against a checked constant.
		expect(complaint).toMatchObject({ reportedDomain: 'mail.example.org', sourceIsp: 'yahoo' });
	});
});

describe('ip-reputation snapshot wire', () => {
	it('carries the snapshot byte-identically', () => {
		canonical<unknown>(IP_REPUTATION_SNAPSHOT_BYTES);
	});

	it('normalizes the snapshot into the stored DTO', () => {
		const normalized = normalizeIpReputationPayload(JSON.parse(IP_REPUTATION_SNAPSHOT_BYTES));
		expect(normalized).not.toBeNull();
		expect(normalized?.ipCount).toBe(1);
		expect(normalized?.ips[0]).toMatchObject({
			ip: '192.0.2.10',
			pool: 'campaign',
			phase: 'ramp',
			currentDay: 5,
			sentToday: 400,
			active: true,
		});
	});

	it('rejects a snapshot whose rows lost a required field', () => {
		const payload = JSON.parse(IP_REPUTATION_SNAPSHOT_BYTES) as {
			ips: Array<Record<string, unknown>>;
		};
		delete payload.ips[0]!['warmingPhase'];
		expect(normalizeIpReputationPayload(payload)).toBeNull();
	});
});
