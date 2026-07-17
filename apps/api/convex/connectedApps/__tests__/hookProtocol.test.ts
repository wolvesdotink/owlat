/**
 * Strict validation of the UNTRUSTED response a connected app returns for a
 * signed synchronous hook. The security property: a response that does not match
 * the exact shape for its kind is rejected (→ null → the caller falls back), and
 * a `gate` response is structurally incapable of granting approval — no accepted
 * shape can flip a decision toward auto-send.
 */

import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@owlat/plugin-kit';
import {
	CONNECTED_APP_HOOK_KINDS,
	isConnectedAppHookKind,
	validateHookResponse,
} from '../hookProtocol';

describe('hook-kind literals', () => {
	it('recognizes exactly draft/gate/score', () => {
		expect([...CONNECTED_APP_HOOK_KINDS]).toEqual(['draft', 'gate', 'score']);
		expect(isConnectedAppHookKind('draft')).toBe(true);
		expect(isConnectedAppHookKind('approve')).toBe(false);
		expect(isConnectedAppHookKind('')).toBe(false);
	});
});

describe('validateHookResponse — draft', () => {
	it('accepts exactly { draft: <non-empty string> }', () => {
		expect(validateHookResponse('draft', { draft: 'Hello there.' })).toEqual({
			hookKind: 'draft',
			draft: 'Hello there.',
		});
	});

	it('rejects an empty draft, a non-string draft, extra keys, and non-objects', () => {
		expect(validateHookResponse('draft', { draft: '' })).toBeNull();
		expect(validateHookResponse('draft', { draft: 42 as unknown as JsonValue })).toBeNull();
		expect(validateHookResponse('draft', { draft: 'ok', extra: 1 })).toBeNull();
		expect(validateHookResponse('draft', { notDraft: 'x' })).toBeNull();
		expect(validateHookResponse('draft', 'a string' as unknown as JsonValue)).toBeNull();
		expect(validateHookResponse('draft', ['draft'] as unknown as JsonValue)).toBeNull();
		expect(validateHookResponse('draft', null)).toBeNull();
	});
});

describe('validateHookResponse — gate (restrict-only)', () => {
	it('accepts { outcome: "no-objection" } only when it is the sole key', () => {
		expect(validateHookResponse('gate', { outcome: 'no-objection' })).toEqual({
			hookKind: 'gate',
			gate: { outcome: 'no-objection' },
		});
		expect(validateHookResponse('gate', { outcome: 'no-objection', reason: 'x' })).toBeNull();
	});

	it('accepts { outcome: "objection", reason } and trims the reason', () => {
		expect(validateHookResponse('gate', { outcome: 'objection', reason: '  hold  ' })).toEqual({
			hookKind: 'gate',
			gate: { outcome: 'objection', reason: 'hold' },
		});
	});

	it('rejects an objection with an empty/missing reason or extra keys', () => {
		expect(validateHookResponse('gate', { outcome: 'objection' })).toBeNull();
		expect(validateHookResponse('gate', { outcome: 'objection', reason: '   ' })).toBeNull();
		expect(
			validateHookResponse('gate', { outcome: 'objection', reason: 'r', extra: 1 })
		).toBeNull();
	});

	it('rejects any approving/unknown outcome — a gate can never grant approval', () => {
		for (const outcome of ['approve', 'approved', 'allow', 'ok', 'send', 'no_objection', true]) {
			expect(validateHookResponse('gate', { outcome } as unknown as JsonValue)).toBeNull();
		}
		expect(validateHookResponse('gate', { allowed: true } as unknown as JsonValue)).toBeNull();
	});
});

describe('validateHookResponse — score', () => {
	it('accepts a bounded [0,1] score with an optional reason', () => {
		expect(validateHookResponse('score', { score: 0 })).toEqual({ hookKind: 'score', score: 0 });
		expect(validateHookResponse('score', { score: 1 })).toEqual({ hookKind: 'score', score: 1 });
		expect(validateHookResponse('score', { score: 0.5, reason: ' spammy ' })).toEqual({
			hookKind: 'score',
			score: 0.5,
			reason: 'spammy',
		});
	});

	it('rejects out-of-range, non-finite, non-number, extra keys, empty reason', () => {
		expect(validateHookResponse('score', { score: -0.1 })).toBeNull();
		expect(validateHookResponse('score', { score: 1.01 })).toBeNull();
		expect(validateHookResponse('score', { score: Number.NaN as unknown as JsonValue })).toBeNull();
		expect(
			validateHookResponse('score', { score: Number.POSITIVE_INFINITY as unknown as JsonValue })
		).toBeNull();
		expect(validateHookResponse('score', { score: '0.5' as unknown as JsonValue })).toBeNull();
		expect(validateHookResponse('score', { score: 0.5, reason: '' })).toBeNull();
		expect(validateHookResponse('score', { score: 0.5, reason: 'r', extra: 1 })).toBeNull();
	});
});

describe('validateHookResponse — prototype safety', () => {
	it('ignores inherited (non-own) properties', () => {
		const polluted = Object.create({ draft: 'inherited' }) as Record<string, JsonValue>;
		// No own keys → not the exact { draft } shape → rejected.
		expect(validateHookResponse('draft', polluted as unknown as JsonValue)).toBeNull();
	});
});
