import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildCanonicalHookResponse,
	parsePluginId,
	SYNC_HOOK_HEADERS,
	SYNC_HOOK_MAX_REQUEST_BYTES,
	SYNC_HOOK_SIGNATURE_SCHEME,
	type SyncHookDescriptor,
	type SyncHookKind,
} from '@owlat/plugin-kit';
import { applyRestrictOnlyGateResult, NO_GATE_OBJECTION } from '../gates';
import {
	createInMemoryCircuitBreakerStore,
	type CircuitBreakerStore,
} from '../hooks/circuitBreaker';
import { hashHookBody, signHookHmac } from '../hooks/signing';
import {
	createInMemorySeenNonceStore,
	invokeSyncHook,
	type SeenNonceStore,
	type SyncHookInvokeDeps,
	type SyncHookTransport,
	type SyncHookTransportOutcome,
} from '../hooks/invoke';
import type { GateHookResult } from '../hooks/result';

const SECRET = 'super-secret-shared-hmac-key';
const PLUGIN = parsePluginId('acme-approvals');
const T0 = 1_700_000_000_000;

function descriptor(overrides: Partial<SyncHookDescriptor> = {}): SyncHookDescriptor {
	return {
		hookId: 'hook-1',
		kind: 'gate',
		pluginId: PLUGIN,
		organizationId: 'org-1',
		endpointUrl: 'https://app.example.com/hooks/gate',
		signingSecret: SECRET,
		deadlineMs: 5_000,
		enabled: true,
		...overrides,
	};
}

/** Options that let a simulated connected app misbehave in one specific way. */
interface AppOptions {
	readonly secret?: string;
	readonly resultBody?: (kind: SyncHookKind) => string;
	readonly tamperSignature?: boolean;
	readonly omitSignature?: boolean;
	readonly kindHeaderOverride?: string;
	readonly requestNonceOverride?: string;
	readonly responseTimestamp?: number;
	readonly fixedResponseNonce?: string;
	readonly status?: number;
	readonly signOverBody?: string;
}

const defaultBody = (kind: SyncHookKind): string => {
	switch (kind) {
		case 'gate':
			return JSON.stringify({ outcome: 'objection', reason: 'Awaiting human approval' });
		case 'draft':
			return JSON.stringify({ draft: { body: 'Suggested reply text' } });
		case 'score':
			return JSON.stringify({ score: 0.42, labels: ['risky'] });
	}
};

/**
 * A transport backed by a well-behaved (or deliberately misbehaving) connected
 * app. It reads the signed request, then produces a correctly signed response
 * using the real crypto primitives, so the whole engine runs end to end.
 */
function connectedApp(
	now: () => number,
	options: AppOptions = {}
): {
	transport: SyncHookTransport;
	callCount: () => number;
} {
	let calls = 0;
	let nonceCounter = 0;
	const secret = options.secret ?? SECRET;
	const transport: SyncHookTransport = async (request) => {
		calls += 1;
		const headers = request.headers;
		const kind = headers[SYNC_HOOK_HEADERS.kind] as SyncHookKind;
		const requestNonce = options.requestNonceOverride ?? headers[SYNC_HOOK_HEADERS.nonce] ?? '';
		const body = options.resultBody ? options.resultBody(kind) : defaultBody(kind);
		const responseNonce = options.fixedResponseNonce ?? `resp-nonce-${++nonceCounter}`;
		const timestamp = options.responseTimestamp ?? now();
		const bodyHashHex = await hashHookBody(options.signOverBody ?? body);
		const canonical = buildCanonicalHookResponse({
			scheme: SYNC_HOOK_SIGNATURE_SCHEME,
			kind,
			requestNonce,
			timestamp,
			nonce: responseNonce,
			bodyHashHex,
		});
		let signature = await signHookHmac(secret, canonical);
		if (options.tamperSignature)
			signature = signature.replace(/.$/, (c) => (c === '0' ? '1' : '0'));

		const responseHeaders: Record<string, string> = {
			[SYNC_HOOK_HEADERS.scheme]: SYNC_HOOK_SIGNATURE_SCHEME,
			[SYNC_HOOK_HEADERS.kind]: options.kindHeaderOverride ?? kind,
			[SYNC_HOOK_HEADERS.requestNonce]: requestNonce,
			[SYNC_HOOK_HEADERS.timestamp]: String(timestamp),
			[SYNC_HOOK_HEADERS.nonce]: responseNonce,
		};
		if (!options.omitSignature) responseHeaders[SYNC_HOOK_HEADERS.signature] = signature;

		const outcome: SyncHookTransportOutcome = {
			ok: true,
			status: options.status ?? 200,
			headers: responseHeaders,
			body,
		};
		return outcome;
	};
	return { transport, callCount: () => calls };
}

interface Harness {
	now: () => number;
	setNow: (ms: number) => void;
	deps: (transport: SyncHookTransport) => SyncHookInvokeDeps;
	circuit: CircuitBreakerStore;
	seenNonces: SeenNonceStore;
	scrubCalls: () => number;
}

function harness(): Harness {
	let current = T0;
	const now = () => current;
	const circuit = createInMemoryCircuitBreakerStore();
	const seenNonces = createInMemorySeenNonceStore(now);
	let scrubCalls = 0;
	const scrubPromptInjection = (text: string): string => {
		scrubCalls += 1;
		return text.replace(/INJECT/g, '[scrubbed]');
	};
	let nonceN = 0;
	return {
		now,
		setNow: (ms) => {
			current = ms;
		},
		circuit,
		seenNonces,
		scrubCalls: () => scrubCalls,
		deps: (transport) => ({
			transport,
			now,
			randomNonce: () => `req-nonce-${++nonceN}`,
			scrubPromptInjection,
			seenNonces,
			circuit,
		}),
	};
}

describe('invokeSyncHook — happy paths', () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it('returns a scrubbed draft suggestion from a valid draft hook', async () => {
		const app = connectedApp(h.now, {
			resultBody: () => JSON.stringify({ draft: { body: 'Hello INJECT world' } }),
		});
		const result = await invokeSyncHook(descriptor({ kind: 'draft' }), {}, h.deps(app.transport));
		expect(result).toEqual({
			kind: 'draft',
			source: 'hook',
			reason: 'ok',
			suggestion: 'Hello [scrubbed] world',
		});
	});

	it('returns a restrict-only objection from a valid gate hook', async () => {
		const app = connectedApp(h.now);
		const result = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(result).toEqual({
			kind: 'gate',
			source: 'hook',
			reason: 'ok',
			gate: { outcome: 'objection', reason: 'Awaiting human approval' },
		});
	});

	it('returns no-objection from a gate hook that abstains', async () => {
		const app = connectedApp(h.now, {
			resultBody: () => JSON.stringify({ outcome: 'no-objection' }),
		});
		const result = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(result).toMatchObject({ kind: 'gate', source: 'hook', gate: NO_GATE_OBJECTION });
	});

	it('clamps an out-of-range score and scrubs labels', async () => {
		const app = connectedApp(h.now, {
			resultBody: () => JSON.stringify({ score: 9.9, labels: ['INJECT-label'] }),
		});
		const result = await invokeSyncHook(descriptor({ kind: 'score' }), {}, h.deps(app.transport));
		expect(result).toEqual({
			kind: 'score',
			source: 'hook',
			reason: 'ok',
			score: 1,
			labels: ['[scrubbed]-label'],
		});
	});
});

describe('invokeSyncHook — gate results can only restrict', () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it('a hook no-objection cannot widen an already-blocked decision', async () => {
		const app = connectedApp(h.now, {
			resultBody: () => JSON.stringify({ outcome: 'no-objection' }),
		});
		const result = (await invokeSyncHook(
			descriptor(),
			{},
			h.deps(app.transport)
		)) as GateHookResult;
		const blocked = { allowed: false as const, objections: ['core gate held'] };
		const applied = applyRestrictOnlyGateResult(blocked, result.gate);
		expect(applied.allowed).toBe(false);
		expect(applied.objections).toEqual(['core gate held']);
	});

	it('a forged (bad-signature) gate response fails closed to an objection, never approval', async () => {
		const app = connectedApp(h.now, { tamperSignature: true });
		const result = (await invokeSyncHook(
			descriptor(),
			{},
			h.deps(app.transport)
		)) as GateHookResult;
		expect(result.source).toBe('fallback');
		expect(result.reason).toBe('signature-invalid');
		expect(result.gate.outcome).toBe('objection');
		// Applying the fallback to an allowed decision must block it (add caution).
		const applied = applyRestrictOnlyGateResult({ allowed: true, objections: [] }, result.gate);
		expect(applied.allowed).toBe(false);
	});
});

describe('invokeSyncHook — failure directions', () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	const timeoutTransport: SyncHookTransport = async () => ({
		ok: false,
		reason: 'timeout',
		error: 'deadline exceeded',
	});

	it('a gate timeout fails closed (objection)', async () => {
		const result = (await invokeSyncHook(
			descriptor(),
			{},
			h.deps(timeoutTransport)
		)) as GateHookResult;
		expect(result).toMatchObject({ kind: 'gate', source: 'fallback', reason: 'transport-timeout' });
		expect(result.gate.outcome).toBe('objection');
	});

	it('a draft timeout fails open (no suggestion, keep host draft)', async () => {
		const result = await invokeSyncHook(
			descriptor({ kind: 'draft' }),
			{},
			h.deps(timeoutTransport)
		);
		expect(result).toEqual({
			kind: 'draft',
			source: 'fallback',
			reason: 'transport-timeout',
			suggestion: null,
		});
	});

	it('a score HTTP 500 fails open (no score)', async () => {
		const app = connectedApp(h.now, { status: 500 });
		const result = await invokeSyncHook(descriptor({ kind: 'score' }), {}, h.deps(app.transport));
		expect(result).toEqual({
			kind: 'score',
			source: 'fallback',
			reason: 'http-status',
			score: null,
			labels: [],
		});
	});

	it('a thrown transport is treated as a network failure', async () => {
		const throwing: SyncHookTransport = async () => {
			throw new Error('socket hang up');
		};
		const result = await invokeSyncHook(descriptor({ kind: 'draft' }), {}, h.deps(throwing));
		expect(result).toMatchObject({ source: 'fallback', reason: 'transport-network' });
	});

	it('uses the descriptor fallback objection reason for a gate', async () => {
		const result = (await invokeSyncHook(
			descriptor({ fallbackObjectionReason: 'Slack approval required' }),
			{},
			h.deps(timeoutTransport)
		)) as GateHookResult;
		expect(result.gate).toEqual({ outcome: 'objection', reason: 'Slack approval required' });
	});
});

describe('invokeSyncHook — response authentication and replay', () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it('rejects a response signed with the wrong secret', async () => {
		const app = connectedApp(h.now, { secret: 'attacker-secret' });
		const result = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(result).toMatchObject({ source: 'fallback', reason: 'signature-invalid' });
	});

	it('rejects a response missing its signature', async () => {
		const app = connectedApp(h.now, { omitSignature: true });
		const result = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(result).toMatchObject({ source: 'fallback', reason: 'signature-missing' });
	});

	it('rejects a response whose body was swapped after signing (integrity)', async () => {
		// App signs over one body but transmits a different one.
		const app = connectedApp(h.now, {
			resultBody: () => JSON.stringify({ outcome: 'no-objection' }),
			signOverBody: JSON.stringify({ outcome: 'objection', reason: 'x' }),
		});
		const result = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(result).toMatchObject({ source: 'fallback', reason: 'signature-invalid' });
	});

	it('rejects a response that does not echo the request nonce', async () => {
		const app = connectedApp(h.now, { requestNonceOverride: 'not-the-request-nonce' });
		const result = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(result).toMatchObject({ source: 'fallback', reason: 'response-mismatch' });
	});

	it('rejects a kind-confused response', async () => {
		const app = connectedApp(h.now, { kindHeaderOverride: 'draft' });
		const result = await invokeSyncHook(descriptor({ kind: 'gate' }), {}, h.deps(app.transport));
		expect(result).toMatchObject({ source: 'fallback', reason: 'response-mismatch' });
	});

	it('rejects a stale response timestamp', async () => {
		const app = connectedApp(h.now, { responseTimestamp: T0 - 10 * 60_000 });
		const result = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(result).toMatchObject({ source: 'fallback', reason: 'timestamp-stale' });
	});

	it('rejects a replayed response nonce on the second call', async () => {
		const app = connectedApp(h.now, { fixedResponseNonce: 'reused-nonce' });
		const deps = h.deps(app.transport);
		const first = await invokeSyncHook(descriptor(), {}, deps);
		expect(first).toMatchObject({ source: 'hook', reason: 'ok' });
		const second = await invokeSyncHook(descriptor(), {}, deps);
		expect(second).toMatchObject({ source: 'fallback', reason: 'nonce-replayed' });
	});
});

describe('invokeSyncHook — malformed results', () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it('falls back when a gate response is well-signed but shape-invalid', async () => {
		const app = connectedApp(h.now, {
			resultBody: () => JSON.stringify({ outcome: 'approve' }),
		});
		const result = (await invokeSyncHook(
			descriptor(),
			{},
			h.deps(app.transport)
		)) as GateHookResult;
		expect(result).toMatchObject({ source: 'fallback', reason: 'result-invalid' });
		expect(result.gate.outcome).toBe('objection');
	});

	it('falls back when the response body is signed but not JSON', async () => {
		const app = connectedApp(h.now, { resultBody: () => 'not json at all' });
		const result = await invokeSyncHook(descriptor({ kind: 'draft' }), {}, h.deps(app.transport));
		expect(result).toMatchObject({ source: 'fallback', reason: 'response-unparseable' });
	});
});

describe('invokeSyncHook — short-circuits before any call', () => {
	let h: Harness;
	beforeEach(() => {
		h = harness();
	});

	it('does not call a disabled hook', async () => {
		const app = connectedApp(h.now);
		const result = await invokeSyncHook(descriptor({ enabled: false }), {}, h.deps(app.transport));
		expect(app.callCount()).toBe(0);
		expect(result).toMatchObject({ source: 'fallback', reason: 'disabled' });
	});

	it('does not call when the request body exceeds the size limit', async () => {
		const app = connectedApp(h.now);
		const big = 'x'.repeat(SYNC_HOOK_MAX_REQUEST_BYTES + 1);
		const result = await invokeSyncHook(
			descriptor({ kind: 'draft' }),
			{ big },
			h.deps(app.transport)
		);
		expect(app.callCount()).toBe(0);
		expect(result).toMatchObject({ source: 'fallback', reason: 'request-too-large' });
	});
});

describe('invokeSyncHook — circuit breaker', () => {
	it('opens after repeated failures and short-circuits, then closes on success', async () => {
		const h = harness();
		const failing: SyncHookTransport = async () => ({
			ok: false,
			reason: 'network',
			error: 'refused',
		});
		const failCalls = vi.fn(failing);
		// Default threshold is 5 consecutive failures.
		for (let i = 0; i < 5; i++) {
			await invokeSyncHook(descriptor(), {}, h.deps(failCalls));
		}
		expect(failCalls).toHaveBeenCalledTimes(5);

		// 6th call is short-circuited (breaker open): transport not invoked.
		const shorted = await invokeSyncHook(descriptor(), {}, h.deps(failCalls));
		expect(failCalls).toHaveBeenCalledTimes(5);
		expect(shorted).toMatchObject({ source: 'fallback', reason: 'circuit-open' });

		// After cooldown a half-open probe is allowed; a success closes the breaker.
		h.setNow(T0 + 31_000);
		const app = connectedApp(h.now);
		const recovered = await invokeSyncHook(descriptor(), {}, h.deps(app.transport));
		expect(recovered).toMatchObject({ source: 'hook', reason: 'ok' });
	});
});
