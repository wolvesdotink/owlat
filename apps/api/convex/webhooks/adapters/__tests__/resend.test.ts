import { describe, it, expect } from 'vitest';
import {
	classifyResendBounce,
	verifySvixHeaders,
} from '../resend';

describe('classifyResendBounce', () => {
	it('classifies user-unknown patterns as hard', () => {
		expect(classifyResendBounce('user unknown')).toBe('hard');
		expect(classifyResendBounce('Mailbox not found')).toBe('hard');
		expect(classifyResendBounce('account has been disabled')).toBe('hard');
	});

	it('classifies temporary/quota patterns as soft', () => {
		expect(classifyResendBounce('mailbox full')).toBe('soft');
		expect(classifyResendBounce('over quota')).toBe('soft');
		expect(classifyResendBounce('try again later')).toBe('soft');
	});

	it('defaults to soft for ambiguous text', () => {
		expect(classifyResendBounce('something weird happened')).toBe('soft');
		expect(classifyResendBounce('')).toBe('soft');
	});

	it('biases toward soft when both patterns match', () => {
		// `rejected` is hard but `try again later` is soft — soft wins.
		expect(classifyResendBounce('rejected, try again later')).toBe('soft');
	});

	it('now classifies the broader permanent-failure patterns shared with the MTA as hard', () => {
		// These were previously (incorrectly) classified soft on the Resend path —
		// they are permanent failures that should blocklist the address.
		expect(classifyResendBounce('user not found')).toBe('hard');
		expect(classifyResendBounce('mailbox unavailable')).toBe('hard');
		expect(classifyResendBounce('relay denied')).toBe('hard');
		expect(classifyResendBounce('5.1.1 user does not exist')).toBe('hard');
	});

	it('treats greylisting as soft', () => {
		expect(classifyResendBounce('greylisted, try again')).toBe('soft');
	});
});

// ─── Svix signature verification ───────────────────────────────────────────

const TEST_SECRET_BASE64 = 'YWJjZGVmZ2hpamtsbW5vcA=='; // 16-byte base64
const TEST_SECRET = `whsec_${TEST_SECRET_BASE64}`;

async function signWithTestSecret(
	svixId: string,
	timestamp: string,
	body: string
): Promise<string> {
	const signedContent = `${svixId}.${timestamp}.${body}`;
	const secretBytes = Uint8Array.from(atob(TEST_SECRET_BASE64), (c) =>
		c.charCodeAt(0)
	);
	const key = await crypto.subtle.importKey(
		'raw',
		secretBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(signedContent)
	);
	return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

describe('verifySvixHeaders', () => {
	const now = 1_700_000_000;
	const body = '{"type":"email.bounced","data":{"email_id":"em_123"}}';
	const svixId = 'msg_test_123';

	it('accepts a valid signature', async () => {
		const ts = String(now);
		const sig = await signWithTestSecret(svixId, ts, body);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			ts,
			`v1,${sig}`,
			TEST_SECRET,
			now
		);
		expect(ok).toBe(true);
	});

	it('accepts when one of multiple signatures matches', async () => {
		const ts = String(now);
		const sig = await signWithTestSecret(svixId, ts, body);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			ts,
			`v1,wrongsig v1,${sig}`,
			TEST_SECRET,
			now
		);
		expect(ok).toBe(true);
	});

	it('rejects a tampered body', async () => {
		const ts = String(now);
		const sig = await signWithTestSecret(svixId, ts, body);
		const ok = await verifySvixHeaders(
			body + 'tampered',
			svixId,
			ts,
			`v1,${sig}`,
			TEST_SECRET,
			now
		);
		expect(ok).toBe(false);
	});

	it('rejects timestamps older than 5 minutes (replay)', async () => {
		const old = now - 400; // 6m40s ago
		const ts = String(old);
		const sig = await signWithTestSecret(svixId, ts, body);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			ts,
			`v1,${sig}`,
			TEST_SECRET,
			now
		);
		expect(ok).toBe(false);
	});

	it('rejects timestamps too far in the future', async () => {
		const future = now + 400;
		const ts = String(future);
		const sig = await signWithTestSecret(svixId, ts, body);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			ts,
			`v1,${sig}`,
			TEST_SECRET,
			now
		);
		expect(ok).toBe(false);
	});

	it('rejects unparseable timestamp', async () => {
		const sig = await signWithTestSecret(svixId, 'not-a-number', body);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			'not-a-number',
			`v1,${sig}`,
			TEST_SECRET,
			now
		);
		expect(ok).toBe(false);
	});

	it('rejects an invalid signature value', async () => {
		const ts = String(now);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			ts,
			'v1,definitelynotvalid',
			TEST_SECRET,
			now
		);
		expect(ok).toBe(false);
	});

	it('rejects a malformed signature header (no version prefix)', async () => {
		const ts = String(now);
		const sig = await signWithTestSecret(svixId, ts, body);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			ts,
			sig, // missing "v1," prefix and comma
			TEST_SECRET,
			now
		);
		expect(ok).toBe(false);
	});

	it('rejects a malformed secret (invalid base64)', async () => {
		const ts = String(now);
		const sig = await signWithTestSecret(svixId, ts, body);
		const ok = await verifySvixHeaders(
			body,
			svixId,
			ts,
			`v1,${sig}`,
			'whsec_!!!not-base64!!!',
			now
		);
		expect(ok).toBe(false);
	});
});
