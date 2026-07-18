import { describe, expect, it } from 'vitest';
import { applyRestrictOnlyGateResult, type GateDecision } from '@owlat/plugin-host';
import { createInMemoryApprovalRepository, type ApprovalRepository } from '../approvalRepository';
import { createApprovalRequest, recordVote, type ApprovalRequest } from '../approvalStore';
import { hmacSha256Hex, sha256Hex } from '../crypto';
import { evaluateGate, serveGateHook, type SlackApprovalsGateConfig } from '../gateHandler';
import { OWLAT_HOOK_HEADERS, type OwlatHookKind } from '../hookWire';
import type { ApprovalNotifier } from '../notify';

const ORG = 'org-a';
const APP_ID = 'app-123';
const SECRET = 'shared-hook-secret';
const MSG = 'm-1';
const BASE_MS = 1_700_000_000_000;
const CONFIG: SlackApprovalsGateConfig = { requiredApprovals: 1, ttlMs: 60_000 };

function recordingNotifier() {
	const calls: Array<{ request: ApprovalRequest; payload: unknown }> = [];
	const notifier: ApprovalNotifier = {
		async postApprovalRequest(request, payload) {
			calls.push({ request, payload });
		},
	};
	return { notifier, calls };
}

function approvedRequest(): ApprovalRequest {
	const base = createApprovalRequest({
		id: MSG,
		organizationId: ORG,
		requiredApprovals: 1,
		createdAtMs: BASE_MS,
		ttlMs: CONFIG.ttlMs,
	});
	const voted = recordVote(base, { voterId: 'U1', vote: 'approve', castAtMs: BASE_MS + 1 });
	return voted.request;
}

describe('evaluateGate', () => {
	it('opens a hold, notifies Slack, and objects on the first ask', async () => {
		const repository = createInMemoryApprovalRepository();
		const { notifier, calls } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG, subject: 'Hi' },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS,
		});
		expect(verdict.outcome).toBe('objection');
		expect(calls).toHaveLength(1);
		expect(repository.get(ORG, MSG)).toBeDefined();
	});

	it('objects while the hold is still pending', async () => {
		const repository = createInMemoryApprovalRepository();
		repository.put(
			createApprovalRequest({
				id: MSG,
				organizationId: ORG,
				requiredApprovals: 2,
				createdAtMs: BASE_MS,
				ttlMs: CONFIG.ttlMs,
			})
		);
		const { notifier } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS + 10,
		});
		expect(verdict.outcome).toBe('objection');
	});

	it('drops its objection only once a real quorum approves', async () => {
		const repository = createInMemoryApprovalRepository();
		repository.put(approvedRequest());
		const { notifier } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS + 100,
		});
		expect(verdict).toEqual({ outcome: 'no-objection' });
	});

	it('keeps holding when a reviewer rejected', async () => {
		const repository = createInMemoryApprovalRepository();
		const rejected = recordVote(
			createApprovalRequest({
				id: MSG,
				organizationId: ORG,
				requiredApprovals: 1,
				createdAtMs: BASE_MS,
				ttlMs: CONFIG.ttlMs,
			}),
			{ voterId: 'U1', vote: 'reject', castAtMs: BASE_MS + 1 }
		);
		repository.put(rejected.request);
		const { notifier } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS + 5,
		});
		expect(verdict.outcome).toBe('objection');
	});

	it('keeps holding when the window has expired without quorum', async () => {
		const repository = createInMemoryApprovalRepository();
		repository.put(
			createApprovalRequest({
				id: MSG,
				organizationId: ORG,
				requiredApprovals: 1,
				createdAtMs: BASE_MS,
				ttlMs: CONFIG.ttlMs,
			})
		);
		const { notifier } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS + CONFIG.ttlMs + 1,
		});
		expect(verdict.outcome).toBe('objection');
	});

	it('holds when the payload has no identifiable draft', async () => {
		const repository = createInMemoryApprovalRepository();
		const { notifier, calls } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { subject: 'no id here' },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS,
		});
		expect(verdict.outcome).toBe('objection');
		expect(calls).toHaveLength(0);
	});

	it('still holds (and still persists the hold) when Slack notification fails', async () => {
		const repository = createInMemoryApprovalRepository();
		const failing: ApprovalNotifier = {
			async postApprovalRequest() {
				throw new Error('slack down');
			},
		};
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository,
			notifier: failing,
			nowMs: BASE_MS,
		});
		expect(verdict.outcome).toBe('objection');
		expect(repository.get(ORG, MSG)).toBeDefined();
	});

	it('fails closed to a hold when the store itself throws', async () => {
		const throwingRepository: ApprovalRepository = {
			get() {
				throw new Error('store down');
			},
			put() {},
			delete() {},
		};
		const { notifier } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository: throwingRepository,
			notifier,
			nowMs: BASE_MS,
		});
		expect(verdict.outcome).toBe('objection');
	});
});

describe('restrict-only composition (Slack cannot force approval or bypass core gates)', () => {
	it('cannot unblock a decision a core gate already blocked', async () => {
		const repository = createInMemoryApprovalRepository();
		repository.put(approvedRequest());
		const { notifier } = recordingNotifier();
		// Best possible app verdict: an approved quorum → no-objection.
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS + 1,
		});
		expect(verdict).toEqual({ outcome: 'no-objection' });

		const coreBlocked: GateDecision = Object.freeze({
			allowed: false,
			objections: Object.freeze(['core: sender not warmed up']),
		});
		const composed = applyRestrictOnlyGateResult(coreBlocked, verdict);
		// The approved Slack quorum does NOT flip the core block to allowed.
		expect(composed.allowed).toBe(false);
		expect(composed.objections).toEqual(['core: sender not warmed up']);
	});

	it('can add a hold to an otherwise-allowed decision', async () => {
		const repository = createInMemoryApprovalRepository();
		repository.put(
			createApprovalRequest({
				id: MSG,
				organizationId: ORG,
				requiredApprovals: 1,
				createdAtMs: BASE_MS,
				ttlMs: CONFIG.ttlMs,
			})
		);
		const { notifier } = recordingNotifier();
		const verdict = await evaluateGate({
			organizationId: ORG,
			payload: { messageId: MSG },
			config: CONFIG,
			repository,
			notifier,
			nowMs: BASE_MS + 1,
		});
		expect(verdict.outcome).toBe('objection');

		const coreAllowed: GateDecision = { allowed: true, objections: [] as const };
		const composed = applyRestrictOnlyGateResult(coreAllowed, verdict);
		expect(composed.allowed).toBe(false);
	});

	it('leaves an allowed decision allowed once quorum is met', async () => {
		const coreAllowed: GateDecision = { allowed: true, objections: [] as const };
		const composed = applyRestrictOnlyGateResult(coreAllowed, { outcome: 'no-objection' });
		expect(composed.allowed).toBe(true);
	});
});

// ---- Full signed HTTP endpoint --------------------------------------------

async function signedGateRequest(opts?: {
	hookKind?: OwlatHookKind;
	nowMs?: number;
	messageId?: string;
	secret?: string;
}) {
	const hookKind = opts?.hookKind ?? 'gate';
	const nowMs = opts?.nowMs ?? BASE_MS;
	const ts = Math.floor(nowMs / 1000);
	const nonce = 'nonce-1';
	const rawBody = JSON.stringify({
		hookKind,
		protocolVersion: 'v1',
		connectedAppId: APP_ID,
		timestampSeconds: ts,
		nonce,
		payload: { messageId: opts?.messageId ?? MSG, subject: 'Re: hello' },
	});
	const bodyBytes = new TextEncoder().encode(rawBody);
	const signingString = [
		'owlat.hook.request.v1',
		hookKind,
		APP_ID,
		String(ts),
		nonce,
		await sha256Hex(bodyBytes),
	].join('\n');
	const signature = `v1=${await hmacSha256Hex(opts?.secret ?? SECRET, signingString)}`;
	return {
		rawBody,
		nonce,
		headers: {
			[OWLAT_HOOK_HEADERS.kind]: hookKind,
			[OWLAT_HOOK_HEADERS.version]: 'v1',
			[OWLAT_HOOK_HEADERS.appId]: APP_ID,
			[OWLAT_HOOK_HEADERS.timestamp]: String(ts),
			[OWLAT_HOOK_HEADERS.nonce]: nonce,
			[OWLAT_HOOK_HEADERS.signature]: signature,
		},
	};
}

describe('serveGateHook (signed endpoint)', () => {
	const connection = {
		organizationId: ORG,
		connectedAppId: APP_ID,
		secret: SECRET,
		config: CONFIG,
	};

	it('answers an authenticated gate call with a signed restrict-only objection', async () => {
		const repository = createInMemoryApprovalRepository();
		const { notifier } = recordingNotifier();
		const req = await signedGateRequest();
		const response = await serveGateHook({
			connection,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: BASE_MS,
			repository,
			notifier,
		});
		expect(response.status).toBe(200);
		const body = JSON.parse(response.body);
		expect(body).toEqual({ outcome: 'objection', reason: expect.any(String) });

		// The response is signed with Owlat's response scheme over the exact body.
		const responseTs = Number(response.headers[OWLAT_HOOK_HEADERS.timestamp]);
		const bodyBytes = new TextEncoder().encode(response.body);
		const expectedSigningString = [
			'owlat.hook.response.v1',
			'gate',
			APP_ID,
			req.nonce,
			String(responseTs),
			await sha256Hex(bodyBytes),
		].join('\n');
		expect(response.headers[OWLAT_HOOK_HEADERS.signature]).toBe(
			`v1=${await hmacSha256Hex(SECRET, expectedSigningString)}`
		);
	});

	it('refuses an unauthenticated call with 401 and no trusted body', async () => {
		const repository = createInMemoryApprovalRepository();
		const { notifier } = recordingNotifier();
		const req = await signedGateRequest({ secret: 'attacker' });
		const response = await serveGateHook({
			connection,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: BASE_MS,
			repository,
			notifier,
		});
		expect(response.status).toBe(401);
		expect(response.body).toBe('');
		// No hold was created off an unauthenticated request.
		expect(repository.get(ORG, MSG)).toBeUndefined();
	});

	it('refuses a signed request for a non-gate hook kind', async () => {
		const repository = createInMemoryApprovalRepository();
		const { notifier } = recordingNotifier();
		const req = await signedGateRequest({ hookKind: 'draft' });
		const response = await serveGateHook({
			connection,
			headers: req.headers,
			rawBody: req.rawBody,
			nowMs: BASE_MS,
			repository,
			notifier,
		});
		expect(response.status).toBe(400);
	});
});
