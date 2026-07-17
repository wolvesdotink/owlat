import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretBox } from '../../lib/credentialCrypto';
import { CURRENT_CONNECTED_APP_SECRET_VERSION } from '../../lib/constants';
import {
	generateConnectedAppSecret,
	openConnectedAppSecret,
	sealConnectedAppSecret,
} from '../secretBox';

describe('connected-app secret box', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'connected-app-test-secret');
	});
	afterEach(() => vi.unstubAllEnvs());

	it('round-trips a sealed secret and stamps the current envelope version', () => {
		const secret = generateConnectedAppSecret();
		const envelope = sealConnectedAppSecret(secret);
		expect(envelope.version).toBe(CURRENT_CONNECTED_APP_SECRET_VERSION);
		expect(openConnectedAppSecret(envelope)).toBe(secret);
	});

	it('never stores the plaintext inside the sealed envelope', () => {
		const secret = generateConnectedAppSecret();
		const envelope = sealConnectedAppSecret(secret);
		expect(JSON.stringify(envelope)).not.toContain(secret);
		// The prefix is a recognizable label, not part of the ciphertext.
		expect(envelope.ciphertext).not.toContain(secret);
	});

	it('mints high-entropy, prefixed, unique secrets', () => {
		const a = generateConnectedAppSecret();
		const b = generateConnectedAppSecret();
		expect(a).not.toBe(b);
		expect(a.startsWith('cah_')).toBe(true);
		// 32 bytes base64url ⇒ 43 chars, plus the 4-char prefix.
		expect(a.length).toBe(47);
		expect(a.slice(4)).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('uses a per-nonce IV so identical plaintext seals to distinct ciphertext', () => {
		const secret = generateConnectedAppSecret();
		const first = sealConnectedAppSecret(secret);
		const second = sealConnectedAppSecret(secret);
		expect(first.iv).not.toBe(second.iv);
		expect(first.ciphertext).not.toBe(second.ciphertext);
		expect(openConnectedAppSecret(first)).toBe(secret);
		expect(openConnectedAppSecret(second)).toBe(secret);
	});

	it('fails closed when the auth tag is tampered', () => {
		const envelope = sealConnectedAppSecret(generateConnectedAppSecret());
		const tamperedTag = Buffer.from(envelope.authTag, 'base64');
		tamperedTag[0] = tamperedTag[0]! ^ 0xff;
		expect(() =>
			openConnectedAppSecret({ ...envelope, authTag: tamperedTag.toString('base64') })
		).toThrow();
	});

	it('is cryptographically domain-separated from other secret-box consumers', () => {
		// A box built under a different salt/info context must not open a
		// connected-app envelope — the derived keys are independent.
		const foreign = createSecretBox('connected-app-test-secret', {
			salt: 'owlat:external-mail:salt:v1',
			info: 'owlat:external-mail:creds:v1',
		});
		const envelope = sealConnectedAppSecret(generateConnectedAppSecret());
		expect(() => foreign.open(envelope)).toThrow();
	});

	it('fails closed when INSTANCE_SECRET is absent', () => {
		vi.stubEnv('INSTANCE_SECRET', '');
		expect(() => sealConnectedAppSecret('x')).toThrow();
	});
});
