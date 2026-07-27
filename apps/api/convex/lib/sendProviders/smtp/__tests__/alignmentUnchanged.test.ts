import { describe, expect, it } from 'vitest';
import { composeMessage } from '@owlat/mail-message';
import { buildVerpAddress } from '@owlat/shared/verp';
import { resolveRelayEnvelopeSender } from '../index';
import { RETURN_PATH_SPF_PROOF_MAX_AGE_MS, returnPathAuthorizesRelay } from '../returnPath';
import { buildReturnPathSpfRecord, parseReturnPathRelaySpfTerms } from '../../../../domains/spf';

/**
 * D11 — NEVER give the two arms of a cell different sending identities. The
 * custom return path changes the RFC5321.MailFrom and NOTHING else: same From
 * domain, same DKIM `d=` (the composer's bytes are what gets signed), same
 * Message-ID scheme, same headers, same body. Only the envelope differs.
 *
 * DMARC has TWO legs, so this file asserts both:
 *
 *  - the DKIM leg, byte-level on the composed message, because the composed
 *    bytes ARE what the signer covers — identical with and without the custom
 *    return path means the DKIM `d=` and its alignment cannot have moved; and
 *  - the SPF leg, which is evaluated on exactly the value this change alters
 *    (RFC 7489 §3.1, the RFC5321.MailFrom domain). Composed bytes cannot see
 *    that at all, so the envelope-sender DOMAIN is asserted directly: it must
 *    be the SAME host the direct-MX arm stamps for this From domain, and the
 *    stamp must be refused when that host's published SPF does not authorise
 *    the transport.
 */

const KEY = 'alignment-key-'.padEnd(32, 'x');
const NOW = Date.UTC(2026, 6, 27, 9, 30, 0);

const PARAMS = {
	from: 'Newsletter <news@example.com>',
	to: ['subscriber@gmail.com'],
	subject: 'Weekly digest',
	html: '<p>Hello</p>',
	text: 'Hello',
	headers: { 'X-Owlat-Message-Id': 'send-42' },
} as const;

function composeOnce() {
	return composeMessage({
		from: PARAMS.from,
		to: [...PARAMS.to],
		subject: PARAMS.subject,
		html: PARAMS.html,
		text: PARAMS.text,
		headers: { ...PARAMS.headers },
	});
}

describe('custom return path — alignment is untouched (D11)', () => {
	it('changes only the envelope sender, never the composed bytes', () => {
		const composed = composeOnce();

		const withoutCustom = resolveRelayEnvelopeSender({
			composedEnvelopeFrom: composed.envelope.from,
			messageId: composed.messageId,
			returnPathHost: undefined,
			verpKey: KEY,
			now: NOW,
		});
		const withCustom = resolveRelayEnvelopeSender({
			composedEnvelopeFrom: composed.envelope.from,
			messageId: composed.messageId,
			returnPathHost: 'bounces.example.com',
			verpKey: KEY,
			now: NOW,
		});

		// The one thing that MAY differ.
		expect(withoutCustom.envelopeFrom).toBe(composed.envelope.from);
		expect(withCustom.envelopeFrom).not.toBe(composed.envelope.from);
		expect(withCustom.envelopeFrom.endsWith('@bounces.example.com')).toBe(true);

		// Everything the receiver authenticates on is unchanged: the resolver is
		// pure and never even sees the message bytes.
		const raw = composed.raw.toString('utf8');
		expect(/^From:.*news@example\.com/im.test(raw)).toBe(true);
		// The VERP address exists ONLY in the SMTP envelope — never in the signed
		// header block, so it cannot move DKIM or DMARC alignment.
		expect(raw).not.toContain(withCustom.envelopeFrom);
		expect(composed.envelope.to).toEqual(['subscriber@gmail.com']);
	});

	it('keeps the same From identity and Message-ID scheme on both arms', () => {
		const a = composeOnce();
		const b = composeOnce();

		const headerValue = (raw: string, name: string): string | undefined =>
			new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(raw)?.[1]?.trim();
		const host = (address: string): string | undefined => address.split('@')[1];

		const rawA = a.raw.toString('utf8');
		const rawB = b.raw.toString('utf8');

		// The From header — the DKIM signing domain and the DMARC alignment domain
		// — is the same string on both arms.
		expect(headerValue(rawA, 'From')).toBe(headerValue(rawB, 'From'));
		expect(headerValue(rawA, 'From')).toContain('news@example.com');
		// Same Message-ID SCHEME (same right-hand side), distinct ids.
		expect(host(a.messageId)).toBe(host(b.messageId));
		expect(a.messageId).not.toBe(b.messageId);
		// Same envelope sender before the return-path decision is applied.
		expect(a.envelope.from).toBe(b.envelope.from);
		expect(host(a.envelope.from)).toBe('example.com');
	});
});

/**
 * The SPF leg. The value under test is the RFC5321.MailFrom DOMAIN, so these
 * assertions are about hosts and published records, not about bytes.
 */
describe('custom return path — the envelope-sender domain posture', () => {
	const RELAY_TERM = 'include:relay.example.net';
	const HOST = 'bounces.example.com';
	const POOL = ['203.0.113.10'];

	/** The record the domain generator publishes at the return-path host. */
	function publishedRecord(terms: readonly string[] = [RELAY_TERM]) {
		return buildReturnPathSpfRecord(POOL, '~all', terms);
	}

	function authorized(overrides: Partial<Parameters<typeof returnPathAuthorizesRelay>[0]> = {}) {
		return returnPathAuthorizesRelay({
			host: HOST,
			relaySpfTerms: parseReturnPathRelaySpfTerms(RELAY_TERM),
			generatedSpfValue: publishedRecord(),
			proof: { verified: true, lastChecked: NOW - 1_000, foundValue: publishedRecord() },
			now: NOW,
			...overrides,
		});
	}

	it('both arms derive the SAME envelope-sender host for one From domain', () => {
		// The direct-MX arm stamps `bounce+…@<perDomainReturnPath ?? global>`
		// (apps/mta/src/smtp/sender.ts). Given the same resolved host, the relay
		// arm must produce the same host — same SPF-evaluation domain, same DMARC
		// SPF alignment, so the two arms' bounce data is comparable (D11).
		const perDomainHost = 'bounces.news.example.com';
		const mtaArm = buildVerpAddress('send-42', perDomainHost, KEY, NOW);
		const relayArm = resolveRelayEnvelopeSender({
			composedEnvelopeFrom: 'news@example.com',
			messageId: 'send-42',
			returnPathHost: perDomainHost,
			verpKey: KEY,
			now: NOW,
		});
		const host = (address: string) => address.split('@')[1];
		expect(host(relayArm.envelopeFrom)).toBe(host(mtaArm));
		expect(host(relayArm.envelopeFrom)).toBe(perDomainHost);
		// And it is NOT the deployment-global host, which is the bug this pins:
		// stamping the global one would put the two arms on different
		// SPF-evaluation domains for the same From domain.
		expect(host(relayArm.envelopeFrom)).not.toBe(HOST);
	});

	it('authorises the stamp when the published record carries the relay term', () => {
		expect(authorized()).toBe(true);
		expect(publishedRecord()).toContain(RELAY_TERM);
		expect(publishedRecord()).toContain('ip4:203.0.113.10');
	});

	it('refuses the stamp when the host authorises the MTA pool ONLY', () => {
		// The shipped record: pool IPs and nothing else. Stamping it on a relay
		// send would make the receiver evaluate SPF for the bounce domain against
		// the relay's address and fail it — degrading the arm being measured.
		const poolOnly = buildReturnPathSpfRecord(POOL, '~all');
		expect(poolOnly).not.toContain(RELAY_TERM);
		expect(
			authorized({
				generatedSpfValue: poolOnly,
				proof: { verified: true, lastChecked: NOW - 1_000, foundValue: poolOnly },
			})
		).toBe(false);
	});

	it('refuses the stamp until the record is actually PUBLISHED and verified', () => {
		expect(
			authorized({ proof: { verified: false, lastChecked: NOW - 1_000, foundValue: undefined } })
		).toBe(false);
		expect(authorized({ proof: undefined })).toBe(false);
	});

	it('trusts what was OBSERVED at the host over what we generated', () => {
		// The operator published a record without the relay term; ours has it.
		// The observed value is the one receivers evaluate, so it wins.
		expect(
			authorized({
				proof: {
					verified: true,
					lastChecked: NOW - 1_000,
					foundValue: buildReturnPathSpfRecord(POOL, '~all'),
				},
			})
		).toBe(false);
	});

	it('withdraws the stamp on stale, future-dated or degenerate proof', () => {
		const record = publishedRecord();
		const proofAt = (lastChecked: number) => ({ verified: true, lastChecked, foundValue: record });
		expect(authorized({ proof: proofAt(NOW - RETURN_PATH_SPF_PROOF_MAX_AGE_MS) })).toBe(false);
		expect(authorized({ proof: proofAt(NOW + 60_000) })).toBe(false);
		expect(authorized({ proof: proofAt(Number.NaN) })).toBe(false);
	});

	it('never matches a term on a substring of a longer host', () => {
		const lookalike = buildReturnPathSpfRecord(POOL, '~all', [
			'include:relay.example.net.attacker.test',
		]);
		expect(
			authorized({
				generatedSpfValue: lookalike,
				proof: { verified: true, lastChecked: NOW - 1_000, foundValue: lookalike },
			})
		).toBe(false);
	});

	it('refuses the stamp when no relay terms are configured at all (D2)', () => {
		expect(authorized({ relaySpfTerms: parseReturnPathRelaySpfTerms(undefined) })).toBe(false);
	});
});
