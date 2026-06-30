import { describe, it, expect } from 'vitest';
import { parseResponse } from '../clamav/client.js';

describe('ClamAV client', () => {
	describe('parseResponse', () => {
		it('parses clean response', () => {
			const result = parseResponse('stream: OK');

			expect(result.clean).toBe(true);
			expect(result.virus).toBeUndefined();
		});

		it('parses clean response with null byte', () => {
			const result = parseResponse('stream: OK\0');

			expect(result.clean).toBe(true);
		});

		it('parses virus found response', () => {
			const result = parseResponse('stream: Eicar-Signature FOUND');

			expect(result.clean).toBe(false);
			expect(result.virus).toBe('Eicar-Signature');
		});

		it('parses virus found response with null byte', () => {
			const result = parseResponse('stream: Win.Test.EICAR_HDB-1 FOUND\0');

			expect(result.clean).toBe(false);
			expect(result.virus).toBe('Win.Test.EICAR_HDB-1');
		});

		it('parses complex virus names', () => {
			const result = parseResponse('stream: Trojan.Generic-12345.Agent FOUND');

			expect(result.clean).toBe(false);
			expect(result.virus).toBe('Trojan.Generic-12345.Agent');
		});

		it('handles ERROR response (fail-open)', () => {
			const result = parseResponse('stream: Max stream size exceeded ERROR');

			expect(result.clean).toBe(true); // Fail-open
			expect(result.skipped).toBe(true);
			expect(result.error).toContain('ClamAV error');
		});

		it('handles unknown response format (fail-open)', () => {
			const result = parseResponse('unexpected response format');

			expect(result.clean).toBe(true); // Fail-open
			expect(result.skipped).toBe(true);
			expect(result.error).toContain('Unknown ClamAV response');
		});

		it('handles empty response', () => {
			const result = parseResponse('');

			expect(result.clean).toBe(true);
			expect(result.skipped).toBe(true);
		});
	});

	// Note: Integration tests requiring a running ClamAV daemon
	// are in a separate test file and need Docker.
	// Use the EICAR test string for verification:
	// X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*
});
