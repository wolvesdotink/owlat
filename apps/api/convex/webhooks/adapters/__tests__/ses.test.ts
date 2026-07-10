import { describe, it, expect } from 'vitest';
import {
	buildSnsCanonicalString,
	extractSpkiDer,
	isAllowedSnsHost,
	pemToDer,
	sesAdapter,
	verifySnsMessage,
	type SnsPublicKeyResolver,
} from '../ses';

// ─── Host pinning ───────────────────────────────────────────────────────────

describe('isAllowedSnsHost', () => {
	it('accepts genuine SNS HTTPS hosts (standard + China partitions)', () => {
		expect(isAllowedSnsHost('https://sns.us-east-1.amazonaws.com/cert.pem')).toBe(true);
		expect(isAllowedSnsHost('https://sns.eu-west-1.amazonaws.com/x')).toBe(true);
		expect(isAllowedSnsHost('https://sns.cn-north-1.amazonaws.com.cn/x')).toBe(true);
	});

	it('rejects non-SNS, non-HTTPS, and look-alike hosts (SSRF / forged cert)', () => {
		expect(isAllowedSnsHost('http://sns.us-east-1.amazonaws.com/x')).toBe(false);
		expect(isAllowedSnsHost('https://evil.com/cert.pem')).toBe(false);
		expect(isAllowedSnsHost('https://sns.us-east-1.amazonaws.com.evil.com/x')).toBe(false);
		expect(isAllowedSnsHost('https://s3.amazonaws.com/cert.pem')).toBe(false);
		expect(isAllowedSnsHost('not a url')).toBe(false);
	});
});

// ─── Canonical string ───────────────────────────────────────────────────────

describe('buildSnsCanonicalString', () => {
	it('orders Notification fields and includes Subject only when present', () => {
		const withSubject = buildSnsCanonicalString({
			Type: 'Notification',
			Message: 'm',
			MessageId: 'id',
			Subject: 's',
			Timestamp: 't',
			TopicArn: 'arn',
		});
		expect(withSubject).toBe(
			'Message\nm\nMessageId\nid\nSubject\ns\nTimestamp\nt\nTopicArn\narn\nType\nNotification\n'
		);

		const noSubject = buildSnsCanonicalString({
			Type: 'Notification',
			Message: 'm',
			MessageId: 'id',
			Timestamp: 't',
			TopicArn: 'arn',
		});
		expect(noSubject).toBe(
			'Message\nm\nMessageId\nid\nTimestamp\nt\nTopicArn\narn\nType\nNotification\n'
		);
	});

	it('orders SubscriptionConfirmation fields with SubscribeURL and Token', () => {
		const s = buildSnsCanonicalString({
			Type: 'SubscriptionConfirmation',
			Message: 'm',
			MessageId: 'id',
			SubscribeURL: 'https://sns.us-east-1.amazonaws.com/confirm',
			Timestamp: 't',
			Token: 'tok',
			TopicArn: 'arn',
		});
		expect(s).toBe(
			'Message\nm\nMessageId\nid\nSubscribeURL\nhttps://sns.us-east-1.amazonaws.com/confirm\nTimestamp\nt\nToken\ntok\nTopicArn\narn\nType\nSubscriptionConfirmation\n'
		);
	});

	it('returns null for an unknown Type or a missing required field', () => {
		expect(buildSnsCanonicalString({ Type: 'Whatever' })).toBeNull();
		expect(buildSnsCanonicalString({ Type: 'Notification', Message: 'm' })).toBeNull();
	});
});

// ─── Signature verification (RSA, generated keypair — no X.509 round-trip) ───

async function makeSigner(): Promise<{
	sign: (data: string) => Promise<string>;
	resolver: SnsPublicKeyResolver;
}> {
	const pair = await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		},
		true,
		['sign', 'verify']
	);
	return {
		sign: async (data: string) => {
			const sig = await crypto.subtle.sign(
				'RSASSA-PKCS1-v1_5',
				pair.privateKey,
				new TextEncoder().encode(data)
			);
			return btoa(String.fromCharCode(...new Uint8Array(sig)));
		},
		resolver: async () => pair.publicKey,
	};
}

describe('verifySnsMessage', () => {
	const base = {
		Type: 'Notification',
		Message: '{"notificationType":"Delivery"}',
		MessageId: 'id-1',
		Timestamp: '2026-07-10T00:00:00.000Z',
		TopicArn: 'arn:aws:sns:us-east-1:1:owlat',
		SignatureVersion: '2',
		SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
	};
	// Freshness is checked against a fixed "now" equal to the envelope's
	// Timestamp so these signature tests stay deterministic.
	const now = Date.parse(base.Timestamp);

	it('accepts a correctly signed message', async () => {
		const { sign, resolver } = await makeSigner();
		const canonical = buildSnsCanonicalString(base)!;
		const msg = { ...base, Signature: await sign(canonical) };
		expect(await verifySnsMessage(msg, resolver, now)).toBe(true);
	});

	it('rejects a tampered message body', async () => {
		const { sign, resolver } = await makeSigner();
		const canonical = buildSnsCanonicalString(base)!;
		const msg = {
			...base,
			Message: '{"notificationType":"Bounce"}',
			Signature: await sign(canonical),
		};
		expect(await verifySnsMessage(msg, resolver, now)).toBe(false);
	});

	it('rejects a SigningCertURL that is not an SNS host (never fetches it)', async () => {
		const { sign, resolver } = await makeSigner();
		const evil = { ...base, SigningCertURL: 'https://evil.com/cert.pem' };
		const canonical = buildSnsCanonicalString(evil)!;
		const msg = { ...evil, Signature: await sign(canonical) };
		expect(await verifySnsMessage(msg, resolver, now)).toBe(false);
	});

	it('rejects a missing signature and an unknown signature version', async () => {
		const { resolver } = await makeSigner();
		expect(await verifySnsMessage({ ...base, Signature: undefined }, resolver, now)).toBe(false);
		expect(
			await verifySnsMessage({ ...base, SignatureVersion: '9', Signature: 'x' }, resolver, now)
		).toBe(false);
	});

	it('rejects a stale envelope outside the freshness window (replay)', async () => {
		const { sign, resolver } = await makeSigner();
		const canonical = buildSnsCanonicalString(base)!;
		const msg = { ...base, Signature: await sign(canonical) };
		// 10 minutes after the signed Timestamp — beyond the 5-minute tolerance.
		expect(await verifySnsMessage(msg, resolver, now + 10 * 60 * 1000)).toBe(false);
	});

	it('rejects an envelope with a missing or unparseable Timestamp', async () => {
		const { sign, resolver } = await makeSigner();
		const canonical = buildSnsCanonicalString(base)!;
		const signature = await sign(canonical);
		expect(
			await verifySnsMessage({ ...base, Timestamp: undefined, Signature: signature }, resolver, now)
		).toBe(false);
	});
});

// ─── SPKI extraction from a real X.509 certificate ───────────────────────────

// Self-signed RSA-2048 certificate (CN=sns.amazonaws.com) — a fixture standing
// in for the X.509 cert SNS serves at SigningCertURL. Exercises the hand-rolled
// DER walker end-to-end (the signature tests above bypass it via the resolver).
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDGTCCAgGgAwIBAgIUNuPW6To8Gvajq/3ty18LtWuQYlcwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRc25zLmFtYXpvbmF3cy5jb20wHhcNMjYwNzEwMDYxMjI5
WhcNMzYwNzA3MDYxMjI5WjAcMRowGAYDVQQDDBFzbnMuYW1hem9uYXdzLmNvbTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKOktnnsEqhctbjx/jYpPtQE
pRlKRSs3JHdCkV0c1qMMgfDHXtR/aLI1cUzs54I4bdm50RlYrKnlQjG9J48IMorr
+BNLyM3aWb5aSuMi7RXQHosRO21P0aDt8JmIRG9E8Brf5n2IK5tjR13xD6jt2l77
RTMgI2CLUygDvQ1YPSrpjgimBE1HoC4oqr7yZ5aYvjpSS9gz18rR9gqaUzK0i1gO
Ovp25usR17mMrDtHzuYmc12LvVgY3XAlWCs8pXE566kSdEdq5cvTRuN4ho/oYpEb
YxBLzbixaiAOHmmxnWpp7T7mr02O2HfgaHdg2BYz9WXLAKQUj4SaAYEaj5yjTiMC
AwEAAaNTMFEwHQYDVR0OBBYEFNxWxccYJMTjN/Broud0H8B7m7qSMB8GA1UdIwQY
MBaAFNxWxccYJMTjN/Broud0H8B7m7qSMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBAFYJBZ1T3ug+np7LjVemyaqjlM7IteNCKCYGgDdW+ccFcGD1
mtnorqIGWnr2/RUbcZz7/1akWOXCJCzVV4l/jOSO9yhx2ad+pHXmO/aQBmJ9NTR0
XeiddLimhqq2cI5OoDza1t9A/so8A+q9eioOaqCXIUhZC1t6AhZhRt0H1SE8hInD
LVUqi6BXGZ/zDMWUe8TywVkDFB1TcHYQ/bbglgTxvzu33mSTb2sBGmKKVQD42s4j
ZQVCCox/DxcBN2GiaYIFOxqF4rykrlsMbjQVVQeFKGLDQOEapEjCWKspYIOkRfXP
Ve9/VDVu8IEHV8wCbPNy8dIueoYUMyAc/O5aZ8g=
-----END CERTIFICATE-----`;

describe('extractSpkiDer', () => {
	it('extracts an SPKI that Web Crypto can import as an RSA verify key', async () => {
		const spki = extractSpkiDer(pemToDer(TEST_CERT_PEM));
		const key = await crypto.subtle.importKey(
			'spki',
			spki as BufferSource,
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['verify']
		);
		expect(key.type).toBe('public');
		expect(key.algorithm.name).toBe('RSASSA-PKCS1-v1_5');
	});

	it('throws on truncated / malformed certificate DER', () => {
		expect(() => extractSpkiDer(new Uint8Array([0x30, 0x02, 0x01, 0x00]))).toThrow();
	});
});

// ─── parseEvent fixtures ─────────────────────────────────────────────────────

function notification(sesMessage: Record<string, unknown>): string {
	return JSON.stringify({
		Type: 'Notification',
		MessageId: 'sns-1',
		Timestamp: '2026-07-10T00:00:00.000Z',
		TopicArn: 'arn',
		Message: JSON.stringify(sesMessage),
	});
}

describe('sesAdapter.parseEvent', () => {
	it('maps a permanent Bounce to a hard email.bounced by provider message id', () => {
		const event = sesAdapter.parseEvent(
			notification({
				notificationType: 'Bounce',
				mail: { messageId: 'ses-msg-1', timestamp: '2026-07-10T00:00:00.000Z' },
				bounce: {
					bounceType: 'Permanent',
					bouncedRecipients: [
						{ emailAddress: 'a@b.com', diagnosticCode: 'smtp; 550 user unknown' },
					],
				},
			})
		);
		expect(event).toMatchObject({
			kind: 'email.bounced',
			providerMessageId: 'ses-msg-1',
			bounceType: 'hard',
			bounceMessage: 'smtp; 550 user unknown',
		});
	});

	it('maps a transient Bounce to a soft email.bounced', () => {
		const event = sesAdapter.parseEvent(
			notification({
				notificationType: 'Bounce',
				mail: { messageId: 'ses-msg-2' },
				bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
			})
		);
		expect(event).toMatchObject({ kind: 'email.bounced', bounceType: 'soft' });
	});

	it('maps a Complaint to email.complained by provider message id', () => {
		const event = sesAdapter.parseEvent(
			notification({
				notificationType: 'Complaint',
				mail: { messageId: 'ses-msg-3' },
				complaint: { complainedRecipients: [{ emailAddress: 'a@b.com' }] },
			})
		);
		expect(event).toMatchObject({ kind: 'email.complained', providerMessageId: 'ses-msg-3' });
	});

	it('falls back to the complained address when the message id is absent', () => {
		const event = sesAdapter.parseEvent(
			notification({
				notificationType: 'Complaint',
				mail: {},
				complaint: { complainedRecipients: [{ emailAddress: 'redacted@b.com' }] },
			})
		);
		expect(event).toMatchObject({ kind: 'email.complained', recipient: 'redacted@b.com' });
	});

	it('maps a Delivery to email.delivered', () => {
		const event = sesAdapter.parseEvent(
			notification({ notificationType: 'Delivery', mail: { messageId: 'ses-msg-4' }, delivery: {} })
		);
		expect(event).toMatchObject({ kind: 'email.delivered', providerMessageId: 'ses-msg-4' });
	});

	it('accepts the Configuration-Set `eventType` alias', () => {
		const event = sesAdapter.parseEvent(
			notification({ eventType: 'Delivery', mail: { messageId: 'ses-msg-5' } })
		);
		expect(event).toMatchObject({ kind: 'email.delivered', providerMessageId: 'ses-msg-5' });
	});

	it('turns a SubscriptionConfirmation into a host-pinned confirm event', () => {
		const event = sesAdapter.parseEvent(
			JSON.stringify({
				Type: 'SubscriptionConfirmation',
				SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
			})
		);
		expect(event).toEqual({
			kind: 'internal.sns_subscription_confirm',
			subscribeUrl: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
		});
	});

	it('drops a SubscriptionConfirmation whose SubscribeURL is not an SNS host', () => {
		const event = sesAdapter.parseEvent(
			JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://evil.com/confirm' })
		);
		expect(event).toBeNull();
	});

	it('ignores UnsubscribeConfirmation and unknown SES notification types', () => {
		expect(sesAdapter.parseEvent(JSON.stringify({ Type: 'UnsubscribeConfirmation' }))).toBeNull();
		expect(
			sesAdapter.parseEvent(notification({ notificationType: 'Reject', mail: { messageId: 'x' } }))
		).toBeNull();
	});
});
