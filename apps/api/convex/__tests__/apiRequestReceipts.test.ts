import { describe, it, expect } from 'vitest';
import type { Doc, Id } from '../_generated/dataModel';
import {
	classifyReceipt,
	erasedReceipt,
	readIdempotencyKey,
	requestFingerprint,
	RECEIPT_TTL_MS,
} from '../auth/apiRequestReceipts';

function requestWithKey(key?: string): Request {
	return new Request('https://api.owlat.example/api/v1/events', {
		method: 'POST',
		headers: key === undefined ? {} : { 'Idempotency-Key': key },
	});
}

describe('readIdempotencyKey', () => {
	it('returns null when the header is absent', () => {
		expect(readIdempotencyKey(requestWithKey())).toEqual({ ok: true, key: null });
	});

	it('accepts a UUID and other printable ASCII keys', () => {
		const uuid = '3f0c1d9e-6c2b-4a51-9a3e-2f6d1b7c8e90';
		expect(readIdempotencyKey(requestWithKey(uuid))).toEqual({ ok: true, key: uuid });
		expect(readIdempotencyKey(requestWithKey('order:1001/v2'))).toEqual({
			ok: true,
			key: 'order:1001/v2',
		});
	});

	it.each([
		['empty', ''],
		['inner space', 'a b'],
		['non-ASCII', 'bestellung-ä'],
		['256 characters', 'k'.repeat(256)],
	])('rejects a %s key', (_label, key) => {
		expect(readIdempotencyKey(requestWithKey(key)).ok).toBe(false);
	});

	it('accepts exactly 255 characters', () => {
		expect(readIdempotencyKey(requestWithKey('k'.repeat(255))).ok).toBe(true);
	});
});

describe('requestFingerprint', () => {
	it('ignores key order and separates endpoints and values', async () => {
		const a = await requestFingerprint('k', 'events', { email: 'a@example.com', eventName: 'x' });
		const b = await requestFingerprint('k', 'events', { eventName: 'x', email: 'a@example.com' });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(
			await requestFingerprint('k', 'transactional', { email: 'a@example.com', eventName: 'x' })
		).not.toBe(a);
		expect(
			await requestFingerprint('k', 'events', { email: 'a@example.com', eventName: 'y' })
		).not.toBe(a);
	});

	it('binds the fingerprint to the Idempotency-Key', async () => {
		const request = { email: 'a@example.com', eventName: 'x' };
		expect(await requestFingerprint('k1', 'events', request)).not.toBe(
			await requestFingerprint('k2', 'events', request)
		);
	});
});

describe('classifyReceipt', () => {
	const now = 1_000_000;
	const receipt = {
		_id: 'r1' as Id<'apiRequestReceipts'>,
		_creationTime: now,
		organizationId: 'org-a',
		keyHash: 'kh',
		endpoint: 'events',
		requestHash: 'h1',
		contactId: 'c1' as Id<'contacts'>,
		isContactCreated: false,
		eventId: 'evt_1',
		triggeredAutomations: 0,
		createdAt: now,
		expiresAt: now + RECEIPT_TTL_MS,
	} satisfies Doc<'apiRequestReceipts'>;
	const tombstone = {
		_id: receipt._id,
		_creationTime: now,
		...erasedReceipt(receipt),
	} satisfies Doc<'apiRequestReceipts'>;
	const conflict = { kind: 'refused', reason: 'idempotency_conflict' };

	it('replays the same endpoint and request', () => {
		expect(classifyReceipt(receipt, 'events', 'h1', now)).toEqual({ kind: 'replay', receipt });
	});

	it('conflicts on another request or endpoint', () => {
		expect(classifyReceipt(receipt, 'events', 'h2', now)).toEqual(conflict);
		expect(classifyReceipt(receipt, 'transactional', 'h1', now)).toEqual(conflict);
	});

	it('treats a missing or expired receipt as absent', () => {
		expect(classifyReceipt(null, 'events', 'h1', now)).toEqual({ kind: 'absent' });
		expect(classifyReceipt(receipt, 'events', 'h1', receipt.expiresAt)).toEqual({ kind: 'absent' });
		expect(classifyReceipt(receipt, 'events', 'h2', receipt.expiresAt + 1)).toEqual({
			kind: 'absent',
		});
	});

	it('keeps only hashes and timestamps in an erased receipt', () => {
		expect(erasedReceipt(receipt)).toEqual({
			organizationId: 'org-a',
			keyHash: 'kh',
			endpoint: 'events',
			requestHash: 'h1',
			isErased: true,
			createdAt: now,
			expiresAt: now + RECEIPT_TTL_MS,
		});
	});

	it('refuses the erased request until expiry, and conflicts on any other', () => {
		expect(classifyReceipt(tombstone, 'events', 'h1', now)).toEqual({
			kind: 'refused',
			reason: 'idempotency_erased',
		});
		expect(classifyReceipt(tombstone, 'events', 'h2', now)).toEqual(conflict);
		expect(classifyReceipt(tombstone, 'events', 'h1', tombstone.expiresAt)).toEqual({
			kind: 'absent',
		});
	});
});
