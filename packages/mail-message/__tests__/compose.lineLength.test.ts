/**
 * Named test gate (b): a lint-style assertion that EVERY emitted physical line is
 * within the RFC 5322 §2.1.1 998-octet hard cap, across every fixture output.
 * A single over-long line (an unfolded recipient list, a long unicode subject, a
 * 998+ octet body line, or a base64 attachment chunk) is a wire violation that
 * some relays reject outright — so it is a hard failure, not a warning.
 */

import { describe, it, expect } from 'vitest';
import { composeMessage } from '../src/index';
import { CORPUS, toComposeInput } from './fixtures/corpus';

const MAX_LINE_OCTETS = 998;

describe('composeMessage output line-length lint (RFC 5322 §2.1.1)', () => {
	for (const testCase of CORPUS) {
		it(`keeps every line <= 998 octets: ${testCase.name}`, () => {
			const { raw } = composeMessage(toComposeInput(testCase));
			const eml = raw.toString('utf-8');
			// The wire must be CRLF-framed with no bare CR or LF; splitting on CRLF
			// therefore yields the true physical lines.
			expect(eml).not.toMatch(/[^\r]\n/);
			expect(eml).not.toMatch(/\r[^\n]/);
			const lines = eml.split('\r\n');
			for (const line of lines) {
				expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(MAX_LINE_OCTETS);
			}
		});
	}
});
