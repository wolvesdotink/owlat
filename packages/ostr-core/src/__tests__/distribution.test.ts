/**
 * The distribution wire formats (plan §8): the DNS TXT tier answer, the query
 * names a consumer builds, and the signed snapshot.
 *
 * Both formats are read from the network by everyone who consumes the
 * registry, so the tests here are written from the parser's side of the trust
 * boundary: round-trips first, then the hostile and merely-broken inputs a
 * zone or a mirror can serve, then the tamper cases the snapshot signature
 * exists to catch.
 */

import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair } from '../crypto.js';
import {
	domainQueryName,
	formatDnsTierAnswer,
	ipQueryName,
	parseDnsTierAnswer,
	signSnapshot,
	verifySnapshotSignature,
	type DnsTierAnswer,
	type SnapshotFile,
	type UnsignedSnapshotFile,
} from '../distribution.js';
import type { SignedTreeHead } from '../merkle/sth.js';
import type { Tier } from '../types.js';

const ANSWER: DnsTierAnswer = {
	v: 1,
	tier: 'trusted',
	score: 87,
	policy: 'ostr-policy-v1',
	asof: '2026-08-20T06:00:00Z',
	ref: 'https://ostr.example/s/example.com',
};

function expectOk(txt: string): DnsTierAnswer {
	const parsed = parseDnsTierAnswer(txt);
	if (!parsed.ok) throw new Error(`expected a parse, got errors: ${parsed.errors.join(', ')}`);
	return parsed.answer;
}

function expectErrors(txt: string): string[] {
	const parsed = parseDnsTierAnswer(txt);
	if (parsed.ok) throw new Error(`expected errors, got ${JSON.stringify(parsed.answer)}`);
	return parsed.errors;
}

describe('DNS tier answer round-trips', () => {
	it('formats the answer of spec 08 §8.1 with `v` first and `ref` last', () => {
		expect(formatDnsTierAnswer(ANSWER)).toBe(
			'v=1; tier=trusted; score=87; policy=ostr-policy-v1; asof=2026-08-20T06:00:00Z; ref=https://ostr.example/s/example.com'
		);
	});

	it('omits `ref` entirely when there is no evidence page', () => {
		const { ref: _ref, ...bare } = ANSWER;
		expect(formatDnsTierAnswer(bare)).not.toContain('ref=');
		expect(expectOk(formatDnsTierAnswer(bare))).toEqual(bare);
	});

	it.each<Tier>(['unknown', 'establishing', 'trusted', 'warned', 'flagged'])(
		'round-trips the %s tier',
		(tier) => {
			expect(expectOk(formatDnsTierAnswer({ ...ANSWER, tier }))).toEqual({ ...ANSWER, tier });
		}
	);

	it.each([0, 1, 50, 99, 100])('round-trips the boundary score %i', (score) => {
		expect(expectOk(formatDnsTierAnswer({ ...ANSWER, score })).score).toBe(score);
	});

	it('does not depend on tag order, as the spec requires of clients', () => {
		const { ref: _ref, ...expected } = ANSWER;
		expect(
			expectOk('asof=2026-08-20T06:00:00Z; score=87; policy=ostr-policy-v1; tier=trusted; v=1')
		).toEqual(expected);
	});

	it('ignores unknown tags, so the answer can grow', () => {
		const answer = expectOk(`${formatDnsTierAnswer(ANSWER)}; heads=3; future=whatever`);
		expect(answer).toEqual(ANSWER);
	});

	it('tolerates the whitespace and trailing semicolons a zone file picks up', () => {
		expect(expectOk(`  ${formatDnsTierAnswer(ANSWER)} ;;  `)).toEqual(ANSWER);
	});

	it('keeps `=` inside a value, so a ref with a query string survives', () => {
		const ref = 'https://ostr.example/s?d=example.com&v=1';
		expect(expectOk(formatDnsTierAnswer({ ...ANSWER, ref })).ref).toBe(ref);
	});
});

describe('DNS tier answer rejects hostile and broken input', () => {
	it.each([
		['empty text', ''],
		['no separators at all', 'v=1 tier=trusted score=87'],
		['a bare word', 'listed'],
		['an SPF record served at the same name', 'v=spf1 include:example.com ~all'],
		['JSON', '{"tier":"trusted","score":87}'],
	])('rejects %s', (_label, txt) => {
		expect(expectErrors(txt).length).toBeGreaterThan(0);
	});

	it('rejects a missing or unsupported version rather than guessing', () => {
		expect(expectErrors('tier=trusted; score=87; policy=p; asof=t')).toContain(
			'unsupported or missing v'
		);
		expect(expectErrors('v=2; tier=trusted; score=87; policy=p; asof=t')).toContain(
			'unsupported or missing v'
		);
	});

	it('rejects a tier it does not know, including one that only looks like one', () => {
		expect(expectErrors('v=1; tier=TRUSTED; score=87; policy=p; asof=t')).toContain('unknown tier');
		expect(expectErrors('v=1; tier=blocked; score=87; policy=p; asof=t')).toContain('unknown tier');
	});

	it.each(['101', '999', '-1', '87.5', '8_7', '0x57', '', ' ', '1e2', 'ninety'])(
		'rejects the out-of-range or non-integer score %p',
		(score) => {
			expect(expectErrors(`v=1; tier=trusted; score=${score}; policy=p; asof=t`)).toContain(
				'score not an integer in [0,100]'
			);
		}
	);

	it('rejects an empty policy or asof, which a client would otherwise display', () => {
		const errors = expectErrors('v=1; tier=trusted; score=87; policy=; asof=');
		expect(errors).toContain('missing policy');
		expect(errors).toContain('missing asof');
	});

	it('reports a duplicated tag instead of silently taking the last one', () => {
		const errors = expectErrors('v=1; tier=trusted; score=87; policy=p; asof=t; tier=flagged');
		expect(errors).toContain('duplicate field: tier');
	});

	it('reports a field with no `=` and one whose name is empty', () => {
		expect(expectErrors('v=1; nonsense; tier=trusted')).toContain('malformed field: nonsense');
		expect(expectErrors('v=1; =orphan; tier=trusted')).toContain('malformed field: =orphan');
	});

	it('collects every problem in one pass, so an operator sees the whole answer', () => {
		expect(expectErrors('v=9; tier=nope; score=101; policy=; asof=').length).toBe(5);
	});

	it('does not choke on a very long or non-ASCII answer', () => {
		expect(expectErrors(`v=1; junk=${'a'.repeat(50_000)}`).length).toBeGreaterThan(0);
		expect(expectOk(`${formatDnsTierAnswer(ANSWER)}; note=trüst — ok`)).toEqual(ANSWER);
	});

	it('never returns a prototype-polluting field as an answer property', () => {
		const parsed = parseDnsTierAnswer(
			'v=1; tier=trusted; score=87; policy=p; asof=t; __proto__=polluted'
		);
		expect(parsed.ok).toBe(true);
		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});
});

describe('query names', () => {
	it('builds the domain name under `q.<zone>`', () => {
		expect(domainQueryName('example.com', 'ostr.example')).toBe('example.com.q.ostr.example');
	});

	it('reverses IPv4 by octet, DNSBL style', () => {
		expect(ipQueryName('192.0.2.7', 'ostr.example')).toBe('7.2.0.192.ip.q.ostr.example');
	});

	it('reverses IPv6 by nibble, all 32 of them', () => {
		const name = ipQueryName('2001:db8::1', 'ostr.example');
		expect(name.endsWith('.ip.q.ostr.example')).toBe(true);
		const nibbles = name.slice(0, -'.ip.q.ostr.example'.length).split('.');
		expect(nibbles).toHaveLength(32);
		expect(nibbles.slice(0, 4)).toEqual(['1', '0', '0', '0']);
		expect(nibbles.slice(-8)).toEqual(['8', 'b', 'd', '0', '1', '0', '0', '2']);
	});

	it('gives every spelling of one IPv6 address the same name', () => {
		const expanded = ipQueryName('2001:0db8:0000:0000:0000:0000:0000:0001', 'ostr.example');
		expect(ipQueryName('2001:db8::1', 'ostr.example')).toBe(expanded);
		expect(ipQueryName('2001:db8:0:0:0:0:0:1', 'ostr.example')).toBe(expanded);
	});

	it('expands an IPv4-mapped literal into the same nibbles as its v6 form', () => {
		expect(ipQueryName('::ffff:192.0.2.7', 'ostr.example')).toBe(
			ipQueryName('::ffff:c000:0207', 'ostr.example')
		);
	});

	it.each([
		'not-an-ip',
		'',
		'256.0.0.1',
		'010.0.0.1',
		'192.0.2.7/32',
		'1.2.3',
		'2001:db8::1::2',
		'2001:zzzz::1',
		'::ffff:010.0.0.1',
	])('refuses to build a name for %p', (ip) => {
		expect(() => ipQueryName(ip, 'ostr.example')).toThrow(/not an IP address/);
	});

	it.each(['192.0.2.7', '2001:db8::1', '::ffff:192.0.2.7'])(
		'always puts %p under the `ip.q.<zone>` suffix consumers slice off',
		(ip) => {
			// The DNSBL-compatible `bl.`/`wl.` views (spec 08 §8.1) are the same
			// reversed labels under a different suffix, so both the reference
			// client and the aggregator's zone generator take this name apart
			// to build them. Changing the layout is allowed; changing it
			// silently is not, and this is where it stops being silent.
			const name = ipQueryName(ip, 'ostr.example');
			expect(name.endsWith('.ip.q.ostr.example')).toBe(true);
			const reversed = name.slice(0, -'.ip.q.ostr.example'.length);
			expect(reversed).not.toContain(' ');
			expect(reversed.split('.').every((label) => label.length > 0)).toBe(true);
		}
	);
});

describe('the tier list', () => {
	/**
	 * Exhaustive by construction: adding a member to `Tier` makes this object a
	 * type error. `TIERS` is not exported, and `@owlat/ostr-client` keeps its
	 * own copy of the same five names for the snapshot and diff-feed guards —
	 * so a tier added here without a matching change there would be rejected by
	 * every consumer, quietly. Until `TIERS` (or an `isTier` guard) is
	 * exported, this test and its twin in the client are the tie.
	 */
	const EVERY_TIER: Readonly<Record<Tier, true>> = {
		unknown: true,
		establishing: true,
		trusted: true,
		warned: true,
		flagged: true,
	};

	it('is exactly the five names the wire format accepts', () => {
		const accepted = (Object.keys(EVERY_TIER) as Tier[]).filter(
			(tier) => parseDnsTierAnswer(`v=1; tier=${tier}; score=1; policy=p; asof=t`).ok
		);
		expect(accepted).toEqual(Object.keys(EVERY_TIER));
		expect(accepted).toHaveLength(5);
	});
});

const HEAD: SignedTreeHead = {
	v: 1,
	logId: 'log.example',
	treeSize: 42,
	rootHash: 'a'.repeat(64),
	timestamp: '2026-08-20T06:00:00Z',
	sig: 'ed25519:aGVhZC1zaWduYXR1cmU=',
};

const UNSIGNED: UnsignedSnapshotFile = {
	v: 1,
	policy: 'ostr-policy-v1',
	asOf: '2026-08-20T06:00:00Z',
	heads: [HEAD],
	entries: [
		{ subject: { domain: 'example.com' }, tier: 'trusted', score: 87 },
		{ subject: { ip: '192.0.2.7' }, tier: 'flagged', score: 4 },
	],
};

describe('snapshot signing', () => {
	const keys = generateEd25519KeyPair();

	it('signs and verifies a snapshot', () => {
		const signed = signSnapshot(UNSIGNED, keys.privateKey);
		expect(signed.sig.startsWith('ed25519:')).toBe(true);
		expect(verifySnapshotSignature(signed, keys.publicKey)).toBe(true);
	});

	it('is deterministic: the same file signs to the same bytes', () => {
		expect(signSnapshot(UNSIGNED, keys.privateKey).sig).toBe(
			signSnapshot({ ...UNSIGNED }, keys.privateKey).sig
		);
	});

	it('verifies after a JSON round-trip, key order and all', () => {
		const signed = signSnapshot(UNSIGNED, keys.privateKey);
		const shuffled = JSON.parse(
			JSON.stringify({
				sig: signed.sig,
				entries: signed.entries,
				heads: signed.heads,
				asOf: signed.asOf,
				policy: signed.policy,
				v: signed.v,
			})
		) as SnapshotFile;
		expect(verifySnapshotSignature(shuffled, keys.publicKey)).toBe(true);
	});

	it('rejects a signature from another aggregator', () => {
		const signed = signSnapshot(UNSIGNED, keys.privateKey);
		expect(verifySnapshotSignature(signed, generateEd25519KeyPair().publicKey)).toBe(false);
	});
});

describe('snapshot tamper detection', () => {
	const keys = generateEd25519KeyPair();
	const signed = signSnapshot(UNSIGNED, keys.privateKey);
	const verify = (file: SnapshotFile): boolean => verifySnapshotSignature(file, keys.publicKey);

	it('catches a promoted subject', () => {
		const entries = signed.entries.map((entry) =>
			entry.subject.ip === undefined ? entry : { ...entry, tier: 'trusted' as Tier, score: 99 }
		);
		expect(verify({ ...signed, entries })).toBe(false);
	});

	it('catches an inserted entry', () => {
		const entries = [
			...signed.entries,
			{ subject: { domain: 'attacker.example' }, tier: 'trusted' as Tier, score: 100 },
		];
		expect(verify({ ...signed, entries })).toBe(false);
	});

	it('catches a deleted entry', () => {
		expect(verify({ ...signed, entries: signed.entries.slice(1) })).toBe(false);
	});

	it('catches reordered entries, because the order is part of the signed bytes', () => {
		expect(verify({ ...signed, entries: [...signed.entries].reverse() })).toBe(false);
	});

	it('catches a rewritten asOf, policy or head set', () => {
		expect(verify({ ...signed, asOf: '2026-08-21T06:00:00Z' })).toBe(false);
		expect(verify({ ...signed, policy: 'ostr-policy-v2' })).toBe(false);
		expect(verify({ ...signed, heads: [{ ...HEAD, treeSize: 43 }] })).toBe(false);
		expect(verify({ ...signed, heads: [] })).toBe(false);
	});

	it('catches a flipped version', () => {
		expect(verify({ ...signed, v: 2 as 1 })).toBe(false);
	});

	it.each([
		['an empty signature', ''],
		['a missing prefix', 'aGVsbG8='],
		['a wrong algorithm prefix', 'ed448:aGVsbG8='],
		['non-base64 payload', 'ed25519:!!!not base64!!!'],
		['a truncated signature', `ed25519:${'A'.repeat(20)}`],
	])('rejects %s without throwing', (_label, sig) => {
		expect(verify({ ...signed, sig })).toBe(false);
	});

	it('rejects a malformed public key without throwing', () => {
		expect(verifySnapshotSignature(signed, 'not-a-key')).toBe(false);
		expect(verifySnapshotSignature(signed, '')).toBe(false);
	});

	it('does not let an unsigned extra field change the verdict', () => {
		// `sig` is computed over v/policy/asOf/heads/entries only. A consumer
		// must therefore not treat any other field as attested — this test
		// pins that fact rather than pretending otherwise.
		const withExtra = { ...signed, mirror: 'evil.example' } as SnapshotFile;
		expect(verify(withExtra)).toBe(true);
	});
});
