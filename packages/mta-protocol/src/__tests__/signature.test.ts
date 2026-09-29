import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MTA_SIGNATURE_HEADER, MTA_TIMESTAMP_HEADER, mtaSigningInput } from '../signature';
import { signMtaRequest } from '../signer';

describe('MTA request signature wire format', () => {
	it('names the two headers the API verifies', () => {
		expect(MTA_SIGNATURE_HEADER.toLowerCase()).toBe('x-mta-signature');
		expect(MTA_TIMESTAMP_HEADER.toLowerCase()).toBe('x-mta-timestamp');
	});

	it('signs `${timestamp}.${body}`', () => {
		expect(mtaSigningInput('1700000000', '{"a":1}')).toBe('1700000000.{"a":1}');
	});

	it('produces the same headers the previous inline signers produced', () => {
		const secret = 'mta-test-secret';
		const body = JSON.stringify({ event: 'delivery.sent', messageId: 'm-1', note: 'café' });
		const nowMs = 1_750_000_123_987;

		const headers = signMtaRequest(secret, body, nowMs);

		const timestamp = String(Math.floor(nowMs / 1000));
		expect(headers[MTA_TIMESTAMP_HEADER]).toBe(timestamp);
		expect(headers[MTA_SIGNATURE_HEADER]).toBe(
			createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
		);
	});

	it('pins a fixed vector so the wire cannot drift silently', () => {
		const headers = signMtaRequest('k', 'body', 1_000_000);
		expect(headers).toEqual({
			[MTA_TIMESTAMP_HEADER]: '1000',
			[MTA_SIGNATURE_HEADER]: createHmac('sha256', 'k').update('1000.body').digest('hex'),
		});
	});
});
