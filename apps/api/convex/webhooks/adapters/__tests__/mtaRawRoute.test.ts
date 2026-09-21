/**
 * The bounded audit row the two raw-carrying MTA routes share.
 */
import { describe, it, expect } from 'vitest';
import { base64ByteLength } from '../mtaRawRoute';

describe('base64ByteLength', () => {
	it('reports the decoded size, ignoring MIME line wrapping and padding', () => {
		const raw = 'hello inbound world';
		const wrapped = Buffer.from(raw)
			.toString('base64')
			.replace(/(.{4})/g, '$1\r\n');
		expect(base64ByteLength(wrapped)).toBe(raw.length);
	});

	it('answers undefined for anything that is not a string', () => {
		// The field comes off the wire: a number or an object here used to reach
		// `.endsWith` and throw into the audit writer's catch, which meant NO
		// audit row for exactly the malformed deliveries worth auditing.
		expect(base64ByteLength(42)).toBeUndefined();
		expect(base64ByteLength({ length: 10 })).toBeUndefined();
		expect(base64ByteLength(undefined)).toBeUndefined();
	});
});
