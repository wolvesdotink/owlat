/**
 * `smtp-server` PARITY DIFFERENTIAL — the drop-in proof.
 *
 * Scripted SMTP conversations run against BOTH a real `smtp-server` (the
 * devDependency ORACLE — I1: the four oracles stay forever; our code never
 * verifies itself alone) AND our in-house listener, and the reply-code sequences
 * are asserted equal EXCEPT at the positions enumerated in `parity.fixtures.ts`
 * (I2: every intended behaviour change is enumerated in a fixture and signed
 * off, NEVER discovered live).
 *
 * Coverage of the parity table named on the L3 card:
 *   greeting · EHLO caps · SPF-reject (550) · VERP-accept (250) ·
 *   quota/oversize (552) · the AUTH chain (235 / 535) · From-forgery (553).
 *
 * The two sanctioned divergence classes:
 *   - enhanced-code enrichment (base code identical; we add the RFC 3463 code
 *     the oracle omits) — I2(c);
 *   - the AUTH-failure base-code collapse (no-auth-oracle, D6/I5) — pre-TLS
 *     530 vs 538, unsupported-mechanism / cancel 535 vs 504 / 501.
 *
 * A raw-socket runner (not `@owlat/smtp-client`) drives both stacks so the
 * scripts can send the exact bytes — AUTH continuations, a `*` cancel — a
 * conforming client would refuse to emit; `smtp-server` stays the ORACLE.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { SMTPServerOptions } from 'smtp-server';
import type { SmtpListenerOptions } from '../types.js';
import { startListener, closeAllListeners, b64 } from './tlsTestUtil.js';
import {
	converse,
	startOracle,
	stopOracle,
	rejectWith,
	type RunningOracle,
	type WireReply,
} from './parityHarness.js';
import { AUTH_BASE_CODE_DIVERGENCES, ENHANCED_CODE_ENRICHMENTS } from './parity.fixtures.js';

// ---------------------------------------------------------------------------
// Matched handler pairs. Each scenario configures the ORACLE and our listener
// so their APPLICATION verdicts are identical — the parity we assert is the SMTP
// FRAMING (greeting / EHLO / accept / DATA prompt / final codes), not the
// application policy, which both sides borrow from the same decision here.
// ---------------------------------------------------------------------------

const SPF_FAIL = 'spf-fail@blocked.test';
const FORGED = 'forged@evil.test';

/** Our listener: shared MAIL/RCPT/DATA policy for the framing scenarios. */
function ourOptions(overrides: Partial<SmtpListenerOptions> = {}): SmtpListenerOptions {
	return {
		hostname: 'mx.test',
		onMailFrom: (addr) => {
			if (addr.address === SPF_FAIL) return { code: 550, text: 'SPF fail' };
			if (addr.address === FORGED) return { code: 553, text: 'From forgery' };
			return undefined;
		},
		...overrides,
	};
}

/** Oracle `smtp-server`: the same MAIL/RCPT/DATA policy expressed via callbacks. */
function oracleOptions(overrides: Partial<SMTPServerOptions> = {}): SMTPServerOptions {
	return {
		disabledCommands: ['STARTTLS'],
		onMailFrom(address, _session, callback) {
			if (address.address === SPF_FAIL) return callback(rejectWith(550, 'SPF fail'));
			if (address.address === FORGED) return callback(rejectWith(553, 'From forgery'));
			return callback();
		},
		...overrides,
	};
}

let oracle: RunningOracle | undefined;

afterEach(async () => {
	await stopOracle(oracle);
	oracle = undefined;
	await closeAllListeners();
});

/** Just the base reply codes of a captured conversation. */
function codes(replies: WireReply[]): number[] {
	return replies.map((r) => r.code);
}

describe('smtp-server parity — SMTP framing', () => {
	it('greeting + full MAIL/RCPT/DATA/QUIT matches base codes on both stacks', async () => {
		oracle = await startOracle(
			oracleOptions({
				onData(stream, _session, callback) {
					stream.on('data', () => {});
					stream.on('end', () => callback());
				},
			})
		);
		const { port: ourPort } = await startListener(ourOptions());
		const script = [
			'EHLO client.test',
			'MAIL FROM:<sender@a.test>',
			'RCPT TO:<rcpt@b.test>',
			'DATA',
			'Subject: hi\r\n\r\nHello world\r\n.\r\n',
			{ send: 'QUIT', expectClose: true },
		];
		const oracleReplies = await converse(oracle.port, script);
		const ourReplies = await converse(ourPort, script);

		// Base-code sequence is byte-identical: 220, 250(EHLO), 250, 250, 354, 250, 221.
		expect(codes(ourReplies)).toEqual([220, 250, 250, 250, 354, 250, 221]);
		expect(codes(ourReplies)).toEqual(codes(oracleReplies));
	});

	it('EHLO advertises a multiline 250 with SIZE on both stacks', async () => {
		// smtp-server only advertises SIZE when its `size` option is set; match our
		// always-on SIZE advertisement so the shared capability is comparable.
		oracle = await startOracle(oracleOptions({ size: 1024 }));
		const { port: ourPort } = await startListener(ourOptions({ maxMessageBytes: 1024 }));
		const script = [{ send: 'EHLO caps.test', expectClose: false }];

		const [ourEhlo] = (
			await converse(ourPort, [...script, { send: 'QUIT', expectClose: true }])
		).filter((r) => r.code === 250);
		const [oracleEhlo] = (
			await converse(oracle.port, [...script, { send: 'QUIT', expectClose: true }])
		).filter((r) => r.code === 250);

		expect(ourEhlo?.code).toBe(250);
		expect(oracleEhlo?.code).toBe(250);
		// Both advertise SIZE as a multiline 250 block (cap SETS differ by design —
		// our list is deliberately minimal — but SIZE is common to both).
		expect(ourEhlo?.lines.some((l) => /\bSIZE\b/.test(l))).toBe(true);
		expect(oracleEhlo?.lines.some((l) => /\bSIZE\b/.test(l))).toBe(true);
		expect(ourEhlo?.lines.length ?? 0).toBeGreaterThan(1);
	});

	it('SPF-reject at MAIL FROM answers 550 on both stacks', async () => {
		oracle = await startOracle(oracleOptions());
		const { port: ourPort } = await startListener(ourOptions());
		const script = [
			'EHLO client.test',
			`MAIL FROM:<${SPF_FAIL}>`,
			{ send: 'QUIT', expectClose: true },
		];
		const oracleReplies = await converse(oracle.port, script);
		const ourReplies = await converse(ourPort, script);
		expect(codes(ourReplies)).toEqual([220, 250, 550, 221]);
		expect(codes(ourReplies)).toEqual(codes(oracleReplies));
	});

	it('VERP-style return path is accepted with 250 on both stacks', async () => {
		oracle = await startOracle(oracleOptions());
		const { port: ourPort } = await startListener(ourOptions());
		const script = [
			'EHLO client.test',
			'MAIL FROM:<bounces+verp=user=dest.test@mx.test>',
			'RCPT TO:<rcpt@b.test>',
			{ send: 'QUIT', expectClose: true },
		];
		const oracleReplies = await converse(oracle.port, script);
		const ourReplies = await converse(ourPort, script);
		expect(codes(ourReplies)).toEqual([220, 250, 250, 250, 221]);
		expect(codes(ourReplies)).toEqual(codes(oracleReplies));
	});

	it('From-forgery at MAIL FROM answers 553 on both stacks', async () => {
		oracle = await startOracle(oracleOptions());
		const { port: ourPort } = await startListener(ourOptions());
		const script = [
			'EHLO client.test',
			`MAIL FROM:<${FORGED}>`,
			{ send: 'QUIT', expectClose: true },
		];
		const oracleReplies = await converse(oracle.port, script);
		const ourReplies = await converse(ourPort, script);
		expect(codes(ourReplies)).toEqual([220, 250, 553, 221]);
		expect(codes(ourReplies)).toEqual(codes(oracleReplies));
	});

	it('quota/oversize is rejected at DATA with 552 on both stacks', async () => {
		// Rejected at the application layer (onData) so the DIALOGUE framing is
		// compared; the listener's native byte-budget 552 is covered by
		// commandLoop.integration.test.ts and the hostile suite.
		oracle = await startOracle(
			oracleOptions({
				onData(stream, _session, callback) {
					stream.on('data', () => {});
					stream.on('end', () => callback(rejectWith(552, 'Quota exceeded')));
				},
			})
		);
		const { port: ourPort } = await startListener(
			ourOptions({ onData: () => ({ code: 552, text: 'Quota exceeded' }) })
		);
		const script = [
			'EHLO client.test',
			'MAIL FROM:<sender@a.test>',
			'RCPT TO:<rcpt@b.test>',
			'DATA',
			'body over quota\r\n.\r\n',
			{ send: 'QUIT', expectClose: true },
		];
		const oracleReplies = await converse(oracle.port, script);
		const ourReplies = await converse(ourPort, script);
		expect(codes(ourReplies)).toEqual([220, 250, 250, 250, 354, 552, 221]);
		expect(codes(ourReplies)).toEqual(codes(oracleReplies));
	});
});

// ---------------------------------------------------------------------------
// AUTH chain. Both stacks accept AUTH over plaintext loopback (no TLS) so the
// dialogue is comparable without a cert; the pre-TLS-refusal divergence uses a
// second, TLS-required pair.
// ---------------------------------------------------------------------------

const GOOD_USER = 'good';
const GOOD_PASS = 'pw';

function ourAuthOptions(requireTls: boolean): SmtpListenerOptions {
	return {
		hostname: 'mx.test',
		auth: {
			mechanisms: ['PLAIN', 'LOGIN'],
			requireTls,
			authenticate: (creds) =>
				creds.username === GOOD_USER && creds.password === GOOD_PASS
					? { ok: true, user: GOOD_USER }
					: { ok: false },
		},
	};
}

function oracleAuthOptions(allowInsecureAuth: boolean, enableStarttls = false): SMTPServerOptions {
	return {
		authMethods: ['PLAIN', 'LOGIN'],
		allowInsecureAuth,
		// smtp-server only replies 538 to pre-TLS AUTH when STARTTLS is actually
		// SUPPORTED (smtp-connection.js:1451 guards on `_isSupported('STARTTLS')`).
		// The `auth-pre-tls-refused` divergence therefore boots the oracle with
		// STARTTLS enabled (its bundled self-signed cert suffices); every other
		// AUTH scenario disables it so the plaintext-loopback dialogue is comparable.
		...(enableStarttls ? {} : { disabledCommands: ['STARTTLS'] }),
		onAuth(auth, _session, callback) {
			if (auth.username === GOOD_USER && auth.password === GOOD_PASS) {
				return callback(null, { user: GOOD_USER });
			}
			return callback(rejectWith(535, 'authentication failed'));
		},
	};
}

describe('smtp-server parity — AUTH chain', () => {
	it('AUTH LOGIN success reaches 235 on both stacks', async () => {
		oracle = await startOracle(oracleAuthOptions(true));
		const { port: ourPort } = await startListener(ourAuthOptions(false));
		const script = [
			'EHLO client.test',
			'AUTH LOGIN',
			b64(GOOD_USER),
			b64(GOOD_PASS),
			{ send: 'QUIT', expectClose: true },
		];
		const oracleReplies = await converse(oracle.port, script);
		const ourReplies = await converse(ourPort, script);
		// 220, 250(EHLO), 334(user), 334(pass), 235, 221.
		expect(codes(ourReplies)).toEqual([220, 250, 334, 334, 235, 221]);
		expect(codes(ourReplies)).toEqual(codes(oracleReplies));
	});

	it('AUTH LOGIN with wrong credentials reaches 535 on both stacks', async () => {
		oracle = await startOracle(oracleAuthOptions(true));
		const { port: ourPort } = await startListener(ourAuthOptions(false));
		const script = [
			'EHLO client.test',
			'AUTH LOGIN',
			b64(GOOD_USER),
			b64('wrong-password'),
			{ send: 'QUIT', expectClose: true },
		];
		const oracleReplies = await converse(oracle.port, script);
		const ourReplies = await converse(ourPort, script);
		expect(codes(ourReplies)).toEqual([220, 250, 334, 334, 535, 221]);
		expect(codes(ourReplies)).toEqual(codes(oracleReplies));
	});
});

// ---------------------------------------------------------------------------
// Enumerated ENHANCED-CODE enrichments (I2(c)). The base codes matched above;
// here we prove OUR replies carry the RFC 3463 code the oracle omits — the
// sanctioned divergence, asserted against the fixture rather than discovered.
// ---------------------------------------------------------------------------

/** Look up an enrichment fixture entry, throwing (not silently skipping) if absent. */
function enrichment(id: string): (typeof ENHANCED_CODE_ENRICHMENTS)[number] {
	const e = ENHANCED_CODE_ENRICHMENTS.find((x) => x.id === id);
	if (!e) throw new Error(`fixture missing enrichment ${id}`);
	return e;
}

describe('sanctioned enhanced-code enrichment (I2c) — enumerated, not live', () => {
	it('our accept/close replies carry the RFC 3463 codes the oracle omits', async () => {
		oracle = await startOracle(
			oracleOptions({
				onData(stream, _session, callback) {
					stream.on('data', () => {});
					stream.on('end', () => callback());
				},
			})
		);
		const { port: ourPort } = await startListener(ourOptions());
		const script = [
			'EHLO client.test',
			'MAIL FROM:<sender@a.test>',
			'RCPT TO:<rcpt@b.test>',
			'DATA',
			'Subject: hi\r\n\r\nbody\r\n.\r\n',
			{ send: 'QUIT', expectClose: true },
		];
		const ourReplies = await converse(ourPort, script);
		const oracleReplies = await converse(oracle.port, script);

		// Reply order: [greeting, EHLO, MAIL, RCPT, DATA(354), body, QUIT].
		const ours: Record<string, WireReply | undefined> = {
			'MAIL FROM': ourReplies[2],
			'RCPT TO': ourReplies[3],
			'DATA body': ourReplies[5],
			QUIT: ourReplies[6],
		};
		const oracles: Record<string, WireReply | undefined> = {
			'MAIL FROM': oracleReplies[2],
			'RCPT TO': oracleReplies[3],
			'DATA body': oracleReplies[5],
			QUIT: oracleReplies[6],
		};

		for (const enrich of ENHANCED_CODE_ENRICHMENTS) {
			if (enrich.step === 'oversize DATA body') continue; // covered by its own scenario
			const our = ours[enrich.step];
			const orc = oracles[enrich.step];
			expect(our, `missing our reply for ${enrich.step}`).toBeDefined();
			expect(our?.code).toBe(enrich.code);
			// We emit the enumerated enhanced code...
			expect(our?.enhanced).toBe(enrich.enhanced);
			// ...the oracle emits the SAME base code but NO enhanced code.
			expect(orc?.code).toBe(enrich.code);
			expect(orc?.enhanced).toBeUndefined();
		}
	});

	it('our oversize 552 carries 5.3.4 where the oracle 552 does not', async () => {
		const enrich = enrichment('message-too-large');
		oracle = await startOracle(
			oracleOptions({
				onData(stream, _session, callback) {
					stream.on('data', () => {});
					stream.on('end', () => callback(rejectWith(enrich.code, 'Quota exceeded')));
				},
			})
		);
		const { port: ourPort } = await startListener(
			ourOptions({
				onData: () => ({ code: enrich.code, enhanced: enrich.enhanced, text: 'Quota exceeded' }),
			})
		);
		const script = [
			'EHLO client.test',
			'MAIL FROM:<sender@a.test>',
			'RCPT TO:<rcpt@b.test>',
			'DATA',
			'too big\r\n.\r\n',
			{ send: 'QUIT', expectClose: true },
		];
		const our = (await converse(ourPort, script))[5];
		const orc = (await converse(oracle.port, script))[5];
		expect(our?.code).toBe(enrich.code);
		expect(our?.enhanced).toBe(enrich.enhanced);
		expect(orc?.code).toBe(enrich.code);
		expect(orc?.enhanced).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Enumerated AUTH-failure BASE-CODE divergences (D6/I5 no-auth-oracle). Every
// AUTH failure collapses to ONE reply so a probe cannot read the failing stage;
// smtp-server leaks the stage via distinct codes. We assert OUR code exactly
// (known from our source), and that the oracle DIVERGES with a different 5xx —
// each pair enumerated in the fixture, never discovered live.
// ---------------------------------------------------------------------------

describe('sanctioned AUTH base-code divergence (D6) — enumerated, not live', () => {
	function divergence(id: string): (typeof AUTH_BASE_CODE_DIVERGENCES)[number] {
		const d = AUTH_BASE_CODE_DIVERGENCES.find((x) => x.id === id);
		if (!d) throw new Error(`fixture missing divergence ${id}`);
		return d;
	}

	it('pre-TLS AUTH: ours 530 vs oracle 538 (encryption required)', async () => {
		const d = divergence('auth-pre-tls-refused');
		// STARTTLS enabled on the oracle so it genuinely emits the enumerated 538
		// (see oracleAuthOptions); insecure AUTH still refused (allowInsecureAuth=false).
		oracle = await startOracle(oracleAuthOptions(false, true));
		const { port: ourPort } = await startListener(ourAuthOptions(true)); // requireTls=true
		const script = ['EHLO client.test', 'AUTH LOGIN', { send: 'QUIT', expectClose: true }];
		const our = (await converse(ourPort, script))[2];
		const orc = (await converse(oracle.port, script))[2];

		expect(our?.code).toBe(d.ourCode); // 530 — the modern encryption-required code
		expect(our?.enhanced).toBe(d.ourEnhanced); // 5.7.0
		expect(orc?.code).toBe(d.oracleCode); // oracle diverges with the enumerated 538
	});

	it('unsupported mechanism: ours 535 (no oracle) vs oracle 504', async () => {
		const d = divergence('auth-bad-mechanism');
		oracle = await startOracle(oracleAuthOptions(true));
		const { port: ourPort } = await startListener(ourAuthOptions(false));
		const script = ['EHLO client.test', 'AUTH FROBNICATE', { send: 'QUIT', expectClose: true }];
		const our = (await converse(ourPort, script))[2];
		const orc = (await converse(oracle.port, script))[2];

		expect(our?.code).toBe(d.ourCode); // 535 — identical to bad credentials
		expect(our?.enhanced).toBe(d.ourEnhanced); // 5.7.8
		expect(orc?.code).toBe(d.oracleCode); // oracle leaks the stage with 504
	});

	it('client cancel (*): ours 535 (no oracle) vs oracle 501', async () => {
		const d = divergence('auth-cancel-or-bad-base64');
		oracle = await startOracle(oracleAuthOptions(true));
		const { port: ourPort } = await startListener(ourAuthOptions(false));
		// AUTH LOGIN, then cancel at the username prompt with `*`.
		const script = ['EHLO client.test', 'AUTH LOGIN', '*', { send: 'QUIT', expectClose: true }];
		const ourReplies = await converse(ourPort, script);
		const oracleReplies = await converse(oracle.port, script);
		// Reply after the `*` is index 3 (220, 250, 334, <verdict>).
		const our = ourReplies[3];
		const orc = oracleReplies[3];

		expect(our?.code).toBe(d.ourCode); // 535
		expect(our?.enhanced).toBe(d.ourEnhanced); // 5.7.8
		expect(orc?.code).toBe(d.oracleCode); // oracle leaks the stage with 501
	});
});
