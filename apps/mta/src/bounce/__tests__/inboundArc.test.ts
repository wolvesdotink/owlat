/**
 * Inbound ARC verification — RFC 8617 (Sealed Mail A5).
 *
 * Hermetic over the checked-in interop fixtures in `fixtures/sealed-mail/arc/`
 * (generated offline by `generate.mjs`; CI never signs anything). The fixtures'
 * ARC public keys are served through a mocked TXT resolver keyed on
 * `<selector>._domainkey.<domain>` exactly as `mailauth` looks them up, so no
 * real DNS is touched.
 *
 * Four scenarios cover the honest-verdict surface + the rescue predicate:
 *   - valid-rescue    : a trusted forwarder's valid chain attesting the original
 *                       passed  -> cv=pass, sealer named, attests=true, RESCUES.
 *   - broken-ams      : the message body was mutated after sealing (AMS body
 *                       hash mismatch) -> cv=fail, no rescue.
 *   - untrusted-sealer: a valid chain, but the sealer is NOT on the trusted list
 *                       -> cv=pass yet NO rescue (trust gate).
 *   - cv-fail         : the ARC-Seal signature is corrupt -> cv=fail, no rescue.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	verifyArcChain,
	shouldArcOverrideDmarc,
	isTrustedForwarder,
	DEFAULT_TRUSTED_ARC_FORWARDERS,
	type ArcDnsResolver,
} from '../inboundArc.js';

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../../fixtures/sealed-mail/arc'
);

/** DNS manifest: `<selector>._domainkey.<domain>` -> TXT record body. */
const keys = JSON.parse(readFileSync(join(fixturesDir, 'keys.json'), 'utf8')) as Record<
	string,
	string
>;

/** Hermetic resolver: serve the fixture keys, ENOTFOUND for anything else. */
const resolver: ArcDnsResolver = async (name, rrtype) => {
	const record = keys[name];
	if (rrtype === 'TXT' && record) return [[record]];
	const err = new Error(`no such record: ${name}`) as Error & { code?: string };
	err.code = 'ENOTFOUND';
	throw err;
};

function fixture(name: string): Buffer {
	return readFileSync(join(fixturesDir, `${name}.eml`));
}

describe('verifyArcChain — RFC 8617 chain verdict (Sealed Mail A5)', () => {
	it('a valid chain from a forwarder attesting the original passed => cv=pass, sealer, attests', async () => {
		const verdict = await verifyArcChain(fixture('valid-rescue'), { resolver });
		expect(verdict.cv).toBe('pass');
		expect(verdict.sealerDomain).toBe('lists.sourceforge.net');
		expect(verdict.attestsOriginalPass).toBe(true);
	});

	it('a mutated body (broken AMS body hash) => cv=fail, no attestation to rely on', async () => {
		const verdict = await verifyArcChain(fixture('broken-ams'), { resolver });
		expect(verdict.cv).toBe('fail');
		expect(verdict.attestsOriginalPass).toBe(false);
	});

	it('an untrusted sealer still produces a real cv=pass verdict naming that sealer', async () => {
		const verdict = await verifyArcChain(fixture('untrusted-sealer'), { resolver });
		expect(verdict.cv).toBe('pass');
		expect(verdict.sealerDomain).toBe('evil-forwarder.example');
		expect(verdict.attestsOriginalPass).toBe(true);
	});

	it('a corrupt ARC-Seal signature => cv=fail', async () => {
		const verdict = await verifyArcChain(fixture('cv-fail'), { resolver });
		expect(verdict.cv).toBe('fail');
	});

	it('a message with no ARC headers => cv=none, no rescue', async () => {
		const plain = Buffer.from(
			['From: a@b.example', 'Subject: no arc', '', 'body', ''].join('\r\n')
		);
		const verdict = await verifyArcChain(plain, { resolver });
		expect(verdict.cv).toBe('none');
		expect(verdict.attestsOriginalPass).toBe(false);
	});
});

describe('shouldArcOverrideDmarc — the DMARC-rescue gate', () => {
	it('RESCUES only a trusted sealer with cv=pass attesting the original passed', async () => {
		const verdict = await verifyArcChain(fixture('valid-rescue'), { resolver });
		expect(
			shouldArcOverrideDmarc(
				{
					arcCv: verdict.cv,
					arcSealerDomain: verdict.sealerDomain,
					arcAttestsOriginalPass: verdict.attestsOriginalPass,
				},
				DEFAULT_TRUSTED_ARC_FORWARDERS
			)
		).toBe(true);
	});

	it('does NOT rescue an untrusted sealer even with a valid attesting chain', async () => {
		const verdict = await verifyArcChain(fixture('untrusted-sealer'), { resolver });
		expect(isTrustedForwarder(verdict.sealerDomain, DEFAULT_TRUSTED_ARC_FORWARDERS)).toBe(false);
		expect(
			shouldArcOverrideDmarc(
				{
					arcCv: verdict.cv,
					arcSealerDomain: verdict.sealerDomain,
					arcAttestsOriginalPass: verdict.attestsOriginalPass,
				},
				DEFAULT_TRUSTED_ARC_FORWARDERS
			)
		).toBe(false);
	});

	it('does NOT rescue a broken chain even from a trusted forwarder', async () => {
		const verdict = await verifyArcChain(fixture('broken-ams'), { resolver });
		expect(
			shouldArcOverrideDmarc(
				{
					arcCv: verdict.cv,
					arcSealerDomain: verdict.sealerDomain,
					arcAttestsOriginalPass: verdict.attestsOriginalPass,
				},
				DEFAULT_TRUSTED_ARC_FORWARDERS
			)
		).toBe(false);
	});

	it('an empty trusted list disables the rescue entirely', async () => {
		const verdict = await verifyArcChain(fixture('valid-rescue'), { resolver });
		expect(
			shouldArcOverrideDmarc(
				{
					arcCv: verdict.cv,
					arcSealerDomain: verdict.sealerDomain,
					arcAttestsOriginalPass: verdict.attestsOriginalPass,
				},
				[]
			)
		).toBe(false);
	});

	it('matches a trusted forwarder on a subdomain of a listed entry', () => {
		expect(isTrustedForwarder('mail-a.google.com', DEFAULT_TRUSTED_ARC_FORWARDERS)).toBe(true);
		expect(isTrustedForwarder('google.com.evil.example', DEFAULT_TRUSTED_ARC_FORWARDERS)).toBe(
			false
		);
	});
});
