import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	MTA_LENGTH_SIGNATURE_HEADER,
	MTA_SIGNATURE_HEADER,
	MTA_TIMESTAMP_HEADER,
	mtaLengthSigningInput,
	mtaSigningInput,
} from '../signature';
import { signMtaRequest } from '../signer';

describe('MTA request signature wire format', () => {
	it('names the headers the API verifies', () => {
		expect(MTA_SIGNATURE_HEADER.toLowerCase()).toBe('x-mta-signature');
		expect(MTA_TIMESTAMP_HEADER.toLowerCase()).toBe('x-mta-timestamp');
		expect(MTA_LENGTH_SIGNATURE_HEADER.toLowerCase()).toBe('x-mta-length-signature');
	});

	it('signs the declared byte length under a prefix no body input can start with', () => {
		expect(mtaLengthSigningInput('1700000000', 42)).toBe('owlat-mta-length-v1.1700000000.42');
	});

	it('signs the UTF-8 byte length, which is what Content-Length declares', () => {
		const body = JSON.stringify({ note: 'café' });
		const headers = signMtaRequest('k', body, 1_000_000);
		expect(headers[MTA_LENGTH_SIGNATURE_HEADER]).toBe(
			createHmac('sha256', 'k')
				.update(`owlat-mta-length-v1.1000.${new TextEncoder().encode(body).length}`)
				.digest('hex')
		);
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
			[MTA_LENGTH_SIGNATURE_HEADER]: createHmac('sha256', 'k')
				.update('owlat-mta-length-v1.1000.4')
				.digest('hex'),
		});
	});
});
