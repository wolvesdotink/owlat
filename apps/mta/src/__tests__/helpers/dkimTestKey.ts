/**
 * One real RSA key pair for suites that need the outbound composer to produce a
 * genuinely DKIM-signed message.
 *
 * RSA keygen is the slowest thing in these suites, so the pair is generated
 * ONCE per test process and shared. It is a throwaway key that never leaves the
 * test run.
 */

import { generateKeyPairSync } from 'crypto';
import type { DkimSigningKey } from '@owlat/mail-message';

const keyPair = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** Selector the helpers below sign and resolve under. */
export const DKIM_TEST_SELECTOR = 'cfbl2026';

/** The DKIM options a mocked `getDkimOptions` seam should resolve for `domain`. */
export function dkimTestOptions(domain: string): DkimSigningKey {
	return {
		domainName: domain,
		keySelector: DKIM_TEST_SELECTOR,
		privateKey: keyPair.privateKey,
	};
}

/**
 * A `mailauth` DNS resolver serving the public half of the shared pair, so a
 * signature this key produced is verified by an INDEPENDENT implementation
 * rather than by our own signer.
 */
export function dkimTestResolver(
	domain: string
): (name: string, rrtype: string) => Promise<string[][]> {
	const record = `v=DKIM1; k=rsa; p=${keyPair.publicKey
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s/g, '')}`;
	const expected = `${DKIM_TEST_SELECTOR}._domainkey.${domain}`;
	return (name, rrtype) => Promise.resolve(rrtype === 'TXT' && name === expected ? [[record]] : []);
}
