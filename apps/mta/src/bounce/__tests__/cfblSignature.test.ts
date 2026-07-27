/**
 * P2-7 (b) — CFBL signature verification.
 *
 * The `CFBL-Address` header publishes a complaint handle to the whole internet
 * and the resulting reports move a control loop. The signature is the entire
 * defence against a third party spraying forged complaints at a chosen send, so
 * this suite is exhaustive about REJECTION: forged, tampered, unsigned,
 * cross-protocol-replayed, expired, and key-rotated tokens must all fail, and
 * every failure must be a RETURNED, COUNTABLE reason — never a thrown error and
 * never an attribution.
 *
 * The clock and the key are parameters, so nothing here depends on wall time or
 * on the environment.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Count every HMAC the module under test computes. Verification probes a range
 * of time windows, so its COST is a security property (a junk-report flood must
 * not become a CPU amplifier) and the only way to pin a cost is to count.
 */
const { hmacCalls } = vi.hoisted(() => ({ hmacCalls: { count: 0 } }));

vi.mock('crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('crypto')>();
	return {
		...actual,
		default: actual,
		createHmac: (...args: Parameters<typeof actual.createHmac>) => {
			hmacCalls.count += 1;
			return actual.createHmac(...args);
		},
	};
});

import {
	ACCEPTED_FUTURE_WINDOWS,
	ACCEPTED_PAST_WINDOWS,
	MAX_HMACS_PER_TOKEN_PARSE,
	buildCfblAddress,
	buildCfblHeaders,
	buildCfblToken,
	isCfblSigningEnabled,
	parseCfblAddress,
	parseCfblToken,
} from '../cfblAddress.js';
import { buildVerpAddress, parseVerpAddress } from '../verp.js';

const KEY = 'cfbl-signature-test-key';
const OTHER_KEY = 'a-different-secret';
const HOST = 'bounces.example.com';
const DAY = 24 * 60 * 60 * 1000;
// A fixed instant well inside a UTC day so ±1 window arithmetic is unambiguous.
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

afterEach(() => {
	delete process.env['BOUNCE_VERP_KEY'];
});

describe('P2-7 (b) — CFBL signature', () => {
	describe('happy path', () => {
		it('round-trips a signed address back to the message id', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW);
			expect(address).toMatch(/^fbl\+[A-Za-z0-9_-]+\+[A-Za-z0-9_-]{14}@bounces\.example\.com$/);
			expect(parseCfblAddress(address!, KEY, NOW)).toEqual({ ok: true, messageId: 'send_abc123' });
		});

		it('verifies across the whole acceptance horizon and one future window', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			for (const offset of [-1, 0, 1, 7, ACCEPTED_PAST_WINDOWS]) {
				expect(parseCfblAddress(address, KEY, NOW + offset * DAY)).toEqual({
					ok: true,
					messageId: 'send_abc123',
				});
			}
		});

		it('verifies regardless of the host the report arrived at (per-domain return paths)', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			const rehosted = address.replace(HOST, 'bounce.acme.com');
			expect(parseCfblAddress(rehosted, KEY, NOW)).toEqual({ ok: true, messageId: 'send_abc123' });
		});
	});

	describe('rejection — counted, never thrown', () => {
		const cases: ReadonlyArray<{ name: string; address: string; reason: string }> = [
			{
				name: 'a hand-built unsigned address',
				address: `fbl+${Buffer.from('send_abc123').toString('base64url')}@${HOST}`,
				reason: 'unsigned',
			},
			{
				name: 'a wholly fabricated MAC',
				address: `fbl+${Buffer.from('send_abc123').toString('base64url')}+AAAAAAAAAAAAAA@${HOST}`,
				reason: 'bad_signature',
			},
			{
				name: 'not a CFBL address at all',
				address: `postmaster@${HOST}`,
				reason: 'not_cfbl',
			},
			{
				name: 'an oversized address',
				address: `fbl+${'A'.repeat(400)}+AAAAAAAAAAAAAA@${HOST}`,
				reason: 'oversized',
			},
		];

		for (const { name, address, reason } of cases) {
			it(`rejects ${name} with reason "${reason}"`, () => {
				expect(() => parseCfblAddress(address, KEY, NOW)).not.toThrow();
				expect(parseCfblAddress(address, KEY, NOW)).toEqual({ ok: false, reason });
			});
		}

		it('rejects a TAMPERED payload — the MAC covers the encoded id', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			// Swap the victim's message id in, keep the attacker's captured MAC.
			const victim = Buffer.from('send_victim9').toString('base64url');
			const mac = address.slice(address.lastIndexOf('+') + 1, address.indexOf('@'));
			const forged = `fbl+${victim}+${mac}@${HOST}`;

			expect(parseCfblAddress(forged, KEY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
		});

		it('rejects a TAMPERED MAC (single-character flip)', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			const flipped =
				address.slice(0, address.indexOf('@') - 1) +
				(address.charAt(address.indexOf('@') - 1) === 'A' ? 'B' : 'A') +
				address.slice(address.indexOf('@'));

			expect(parseCfblAddress(flipped, KEY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
		});

		it('rejects a token signed with a different key (key rotation / foreign signer)', () => {
			const address = buildCfblAddress('send_abc123', HOST, OTHER_KEY, NOW)!;
			expect(parseCfblAddress(address, KEY, NOW)).toEqual({
				ok: false,
				reason: 'bad_signature',
			});
		});

		it('rejects an EXPIRED token distinctly from a forged one', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			const stale = NOW + (ACCEPTED_PAST_WINDOWS + 1) * DAY;
			expect(parseCfblAddress(address, KEY, stale)).toEqual({ ok: false, reason: 'expired' });
		});

		it('degrades an ancient token past the expiry probe horizon to bad_signature, not a throw', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			expect(parseCfblAddress(address, KEY, NOW + 400 * DAY)).toEqual({
				ok: false,
				reason: 'bad_signature',
			});
		});

		it('rejects everything when no key is configured (unverifiable, not trusted)', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			expect(parseCfblAddress(address, '', NOW)).toEqual({ ok: false, reason: 'unverifiable' });
		});
	});

	describe('cross-protocol replay — the MAC is domain-separated from VERP', () => {
		it('a captured VERP bounce token cannot be replayed as a CFBL token', () => {
			const verp = buildVerpAddress('send_abc123', HOST, KEY, NOW);
			const asCfbl = verp.replace(/^bounce\+/, 'fbl+');
			expect(parseCfblAddress(asCfbl, KEY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
		});

		it('a captured CFBL token cannot be replayed as a VERP bounce token', () => {
			const cfbl = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;
			const asVerp = cfbl.replace(/^fbl\+/, 'bounce+');
			expect(parseVerpAddress(asVerp, KEY, NOW)).toBeNull();
		});
	});

	describe('emission is refused rather than degraded', () => {
		it('builds nothing without a signing key', () => {
			expect(isCfblSigningEnabled('')).toBe(false);
			expect(buildCfblToken('send_abc123', '', NOW)).toBeNull();
			expect(buildCfblAddress('send_abc123', HOST, '', NOW)).toBeNull();
			expect(
				buildCfblHeaders({
					messageId: 'send_abc123',
					cfblHost: HOST,
					fromDomain: HOST,
					key: '',
					now: NOW,
				})
			).toEqual({ outcome: 'no_key', headers: {} });
		});

		it('builds nothing for an empty or implausibly long message id', () => {
			expect(buildCfblAddress('', HOST, KEY, NOW)).toBeNull();
			expect(buildCfblAddress('m'.repeat(201), HOST, KEY, NOW)).toBeNull();
		});

		it('builds nothing without a return-path host', () => {
			expect(buildCfblAddress('send_abc123', '', KEY, NOW)).toBeNull();
		});

		it('falls back to BOUNCE_VERP_KEY when no explicit key is passed', () => {
			process.env['BOUNCE_VERP_KEY'] = KEY;
			expect(isCfblSigningEnabled()).toBe(true);
			const address = buildCfblAddress('send_abc123', HOST, undefined, NOW)!;
			expect(parseCfblAddress(address, undefined, NOW)).toEqual({
				ok: true,
				messageId: 'send_abc123',
			});
		});
	});

	describe('verification cost is BOUNDED (the CPU-amplifier defence)', () => {
		/** The oldest window verification will probe at all, in whole days back. */
		const oldestProbedWindow = MAX_HMACS_PER_TOKEN_PARSE - ACCEPTED_FUTURE_WINDOWS - 1;

		it('costs exactly MAX_HMACS_PER_TOKEN_PARSE on a maximally-old token', () => {
			// The worst case for a token we really signed: it matches only on the
			// very last window the expiry probe reaches, so every probe runs.
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW - oldestProbedWindow * DAY)!;

			hmacCalls.count = 0;
			expect(parseCfblAddress(address, KEY, NOW)).toEqual({ ok: false, reason: 'expired' });

			// Not "at most": the constant must be the ACTUAL bound, or its docstring
			// is describing a cost nobody measured.
			expect(hmacCalls.count).toBe(MAX_HMACS_PER_TOKEN_PARSE);
		});

		it('a forged MAC cannot cost more than the same bound', () => {
			const forged = `fbl+${Buffer.from('send_abc123').toString('base64url')}+AAAAAAAAAAAAAA@${HOST}`;

			hmacCalls.count = 0;
			expect(parseCfblAddress(forged, KEY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });

			// A flood of junk is the reachable case: an attacker picks the MAC, so
			// this is the cost they can force per report.
			expect(hmacCalls.count).toBe(MAX_HMACS_PER_TOKEN_PARSE);
		});

		it('a current-window token costs one HMAC — the probe is lazy, not eager', () => {
			const address = buildCfblAddress('send_abc123', HOST, KEY, NOW)!;

			hmacCalls.count = 0;
			expect(parseCfblAddress(address, KEY, NOW)).toEqual({ ok: true, messageId: 'send_abc123' });

			// Windows are probed newest-first from the future skew window, so a
			// legitimate fresh report costs two, not ninety-two.
			expect(hmacCalls.count).toBe(ACCEPTED_FUTURE_WINDOWS + 1);
		});
	});

	describe('token form (the CFBL-Feedback-ID carrier)', () => {
		it('verifies the bare token exactly as it verifies inside an address', () => {
			const token = buildCfblToken('send_abc123', KEY, NOW)!;
			expect(parseCfblToken(token, KEY, NOW)).toEqual({ ok: true, messageId: 'send_abc123' });
			expect(parseCfblAddress(`fbl+${token}@${HOST}`, KEY, NOW)).toEqual({
				ok: true,
				messageId: 'send_abc123',
			});
		});

		it('rejects a non-token value (Gmail Feedback-ID) as simply not-CFBL', () => {
			expect(parseCfblToken('campaign:cmp1:topic:abc12', KEY, NOW)).toEqual({
				ok: false,
				reason: 'not_cfbl',
			});
		});
	});
});
