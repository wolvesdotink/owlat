import { describe, it, expect } from 'vitest';
import {
	buildSnsCanonicalString,
	isAllowedSnsHost,
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

	it('accepts a correctly signed message', async () => {
		const { sign, resolver } = await makeSigner();
		const canonical = buildSnsCanonicalString(base)!;
		const msg = { ...base, Signature: await sign(canonical) };
		expect(await verifySnsMessage(msg, resolver)).toBe(true);
	});

	it('rejects a tampered message body', async () => {
		const { sign, resolver } = await makeSigner();
		const canonical = buildSnsCanonicalString(base)!;
		const msg = {
			...base,
			Message: '{"notificationType":"Bounce"}',
			Signature: await sign(canonical),
		};
		expect(await verifySnsMessage(msg, resolver)).toBe(false);
	});

	it('rejects a SigningCertURL that is not an SNS host (never fetches it)', async () => {
		const { sign, resolver } = await makeSigner();
		const evil = { ...base, SigningCertURL: 'https://evil.com/cert.pem' };
		const canonical = buildSnsCanonicalString(evil)!;
		const msg = { ...evil, Signature: await sign(canonical) };
		expect(await verifySnsMessage(msg, resolver)).toBe(false);
	});

	it('rejects a missing signature and an unknown signature version', async () => {
		const { resolver } = await makeSigner();
		expect(await verifySnsMessage({ ...base, Signature: undefined }, resolver)).toBe(false);
		expect(
			await verifySnsMessage({ ...base, SignatureVersion: '9', Signature: 'x' }, resolver)
		).toBe(false);
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
