import { describe, expect, it } from 'vitest';
import {
	buildCanonicalHookRequest,
	buildCanonicalHookResponse,
	canonicalizeJson,
	clampSyncHookDeadline,
	SYNC_HOOK_DEFAULT_DEADLINE_MS,
	SYNC_HOOK_MAX_DEADLINE_MS,
	SYNC_HOOK_MIN_DEADLINE_MS,
	SYNC_HOOK_SIGNATURE_SCHEME,
	SyncHookContractError,
	utf8ByteLength,
	type SyncHookRequestEnvelope,
	type SyncHookResponseEnvelope,
} from '../syncHook';
import { parsePluginId } from '../pluginId';

const pluginId = parsePluginId('acme-approvals');

function requestEnvelope(
	overrides: Partial<SyncHookRequestEnvelope> = {}
): SyncHookRequestEnvelope {
	return {
		scheme: SYNC_HOOK_SIGNATURE_SCHEME,
		kind: 'gate',
		hookId: 'hook-1',
		pluginId,
		organizationId: 'org-1',
		timestamp: 1_700_000_000_000,
		nonce: 'nonce-abc',
		bodyHashHex: 'ab12',
		...overrides,
	};
}

function responseEnvelope(
	overrides: Partial<SyncHookResponseEnvelope> = {}
): SyncHookResponseEnvelope {
	return {
		scheme: SYNC_HOOK_SIGNATURE_SCHEME,
		kind: 'gate',
		requestNonce: 'nonce-abc',
		timestamp: 1_700_000_000_500,
		nonce: 'resp-nonce',
		bodyHashHex: 'cd34',
		...overrides,
	};
}

describe('canonicalizeJson', () => {
	it('sorts object keys at every level so equal values serialize identically', () => {
		const a = canonicalizeJson({ b: 1, a: { d: 2, c: 3 } });
		const b = canonicalizeJson({ a: { c: 3, d: 2 }, b: 1 });
		expect(a).toBe(b);
		expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
	});

	it('preserves array order (arrays are not sorted)', () => {
		expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
	});

	it('rejects non-finite numbers rather than emitting null', () => {
		expect(() => canonicalizeJson(Number.NaN as unknown as number)).toThrow(SyncHookContractError);
		expect(() => canonicalizeJson({ x: Infinity } as never)).toThrow(SyncHookContractError);
	});

	it('escapes strings via JSON semantics', () => {
		expect(canonicalizeJson('a"b\n')).toBe('"a\\"b\\n"');
	});
});

describe('buildCanonicalHookRequest', () => {
	it('binds every envelope field in a fixed newline-delimited order', () => {
		expect(buildCanonicalHookRequest(requestEnvelope())).toBe(
			[
				SYNC_HOOK_SIGNATURE_SCHEME,
				'request',
				'gate',
				'hook-1',
				'acme-approvals',
				'org-1',
				'1700000000000',
				'nonce-abc',
				'ab12',
			].join('\n')
		);
	});

	it('changes when any single field changes (tamper-evidence)', () => {
		const base = buildCanonicalHookRequest(requestEnvelope());
		expect(buildCanonicalHookRequest(requestEnvelope({ kind: 'draft' }))).not.toBe(base);
		expect(buildCanonicalHookRequest(requestEnvelope({ nonce: 'other' }))).not.toBe(base);
		expect(buildCanonicalHookRequest(requestEnvelope({ bodyHashHex: 'ab13' }))).not.toBe(base);
		expect(buildCanonicalHookRequest(requestEnvelope({ organizationId: 'org-2' }))).not.toBe(base);
	});

	it('rejects an out-of-range timestamp or non-hex body hash', () => {
		expect(() => buildCanonicalHookRequest(requestEnvelope({ timestamp: -1 }))).toThrow(
			SyncHookContractError
		);
		expect(() => buildCanonicalHookRequest(requestEnvelope({ bodyHashHex: 'XYZ' }))).toThrow(
			SyncHookContractError
		);
	});
});

describe('buildCanonicalHookResponse', () => {
	it('binds the request nonce so a response cannot be replayed onto another request', () => {
		const base = buildCanonicalHookResponse(responseEnvelope());
		expect(buildCanonicalHookResponse(responseEnvelope({ requestNonce: 'different' }))).not.toBe(
			base
		);
	});

	it('is domain-separated from the request string (request vs response tag)', () => {
		const req = buildCanonicalHookRequest(
			requestEnvelope({ nonce: 'n', bodyHashHex: 'aa', timestamp: 1 })
		);
		const res = buildCanonicalHookResponse(
			responseEnvelope({ requestNonce: 'n', nonce: 'n', bodyHashHex: 'aa', timestamp: 1 })
		);
		expect(req).not.toBe(res);
	});
});

describe('clampSyncHookDeadline', () => {
	it('clamps below the floor and above the ceiling', () => {
		expect(clampSyncHookDeadline(1)).toBe(SYNC_HOOK_MIN_DEADLINE_MS);
		expect(clampSyncHookDeadline(10_000_000)).toBe(SYNC_HOOK_MAX_DEADLINE_MS);
	});

	it('falls back to the default for a non-finite value', () => {
		expect(clampSyncHookDeadline(Number.NaN)).toBe(SYNC_HOOK_DEFAULT_DEADLINE_MS);
	});

	it('keeps an in-range integer', () => {
		expect(clampSyncHookDeadline(4_200)).toBe(4_200);
	});
});

describe('utf8ByteLength', () => {
	it('counts real octets, not UTF-16 code units', () => {
		expect(utf8ByteLength('a')).toBe(1);
		expect(utf8ByteLength('€')).toBe(3);
		expect(utf8ByteLength('😀')).toBe(4);
	});
});
