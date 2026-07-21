/**
 * The hook client's own contract, checked away from the Tier-2 replay.
 *
 * `verifyHookResponse` is the only checked-in worked example of verifying an
 * Owlat hook answer, so it is a tutorial source as much as a harness: it has to
 * refuse a near-miss signature without leaking, through timing, how much of it
 * matched, and it has to fail closed on a malformed header instead of throwing.
 *
 * The expected signature below is recomputed from the PUBLISHED canonical string
 * with `node:crypto` primitives rather than by calling the module under test, so
 * these cases pin the wire contract too, not just the comparison.
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HOOK_HEADERS, verifyHookResponse } from '../hookClient';

const SECRET = 'hook-secret-for-tests';
const APP_ID = 'app-conformance';
const REQUEST_NONCE = 'nonce-response-1';
const TIMESTAMP = '1700000000';
const BODY = JSON.stringify({ outcome: 'objection', reason: 'holding for review' });

function expectedSignature(): string {
	const signingString = [
		'owlat.hook.response.v1',
		'gate',
		APP_ID,
		REQUEST_NONCE,
		TIMESTAMP,
		createHash('sha256').update(BODY, 'utf8').digest('hex'),
	].join('\n');
	return `v1=${createHmac('sha256', SECRET).update(signingString, 'utf8').digest('hex')}`;
}

function verify(signature: string | undefined): Promise<boolean> {
	const headers: Record<string, string> = { [HOOK_HEADERS.timestamp]: TIMESTAMP };
	if (signature !== undefined) headers[HOOK_HEADERS.signature] = signature;
	return verifyHookResponse({
		secret: SECRET,
		appId: APP_ID,
		requestNonce: REQUEST_NONCE,
		headers,
		body: BODY,
	});
}

/** Flip the last hex character, keeping the length and every other byte. */
function tamperLastCharacter(signature: string): string {
	const last = signature.slice(-1);
	return `${signature.slice(0, -1)}${last === '0' ? '1' : '0'}`;
}

describe('verifyHookResponse', () => {
	it('accepts a signature over the canonical response string', async () => {
		await expect(verify(expectedSignature())).resolves.toBe(true);
	});

	// The near-miss case: same length, one differing byte at the very end. A
	// comparison that short-circuits on the first mismatch answers this faster
	// than one that differs early, which is what constant-time comparison denies.
	it('rejects a signature differing only in its final hex character', async () => {
		const tampered = tamperLastCharacter(expectedSignature());
		expect(tampered).toHaveLength(expectedSignature().length);
		expect(tampered).not.toBe(expectedSignature());
		await expect(verify(tampered)).resolves.toBe(false);
	});

	it('rejects a truncated signature rather than throwing on the length mismatch', async () => {
		await expect(verify(expectedSignature().slice(0, -4))).resolves.toBe(false);
		await expect(verify('v1=')).resolves.toBe(false);
	});

	it('fails closed when the signature or timestamp header is absent', async () => {
		await expect(verify(undefined)).resolves.toBe(false);
		await expect(
			verifyHookResponse({
				secret: SECRET,
				appId: APP_ID,
				requestNonce: REQUEST_NONCE,
				headers: { [HOOK_HEADERS.signature]: expectedSignature() },
				body: BODY,
			})
		).resolves.toBe(false);
	});

	it('binds the answer to the request nonce, the app and the body', async () => {
		const signature = expectedSignature();
		const base = {
			secret: SECRET,
			appId: APP_ID,
			requestNonce: REQUEST_NONCE,
			headers: { [HOOK_HEADERS.timestamp]: TIMESTAMP, [HOOK_HEADERS.signature]: signature },
			body: BODY,
		};
		await expect(verifyHookResponse({ ...base, requestNonce: 'other-nonce' })).resolves.toBe(false);
		await expect(verifyHookResponse({ ...base, appId: 'app-other' })).resolves.toBe(false);
		await expect(verifyHookResponse({ ...base, body: `${BODY} ` })).resolves.toBe(false);
		await expect(verifyHookResponse({ ...base, secret: 'other-secret' })).resolves.toBe(false);
	});
});
