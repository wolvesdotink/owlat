/**
 * Tests for the pure attachment matcher (inbox/attachmentMatch.ts):
 *   - detectAttachmentRequest fires on "can you send X" / "please forward" /
 *     "see attached" and stays quiet on ordinary prose.
 *   - pickAttachmentSuggestion returns a single confident suggestion when the
 *     top hit clearly wins, and an ambiguous shortlist when it doesn't.
 * No Convex ctx, no live model.
 */

import { describe, it, expect } from 'vitest';
import {
	detectAttachmentRequest,
	pickAttachmentSuggestion,
	MATCH_FLOOR,
	AMBIGUITY_MARGIN,
	MAX_CANDIDATES,
	type AttachmentCandidate,
} from '../attachmentMatch';

describe('detectAttachmentRequest', () => {
	it('fires on explicit "can you send me the …" requests and extracts a query', () => {
		const r = detectAttachmentRequest('Hi — can you send me the Q3 financials report?');
		expect(r.requested).toBe(true);
		expect(r.query).toContain('q3');
		expect(r.query).toContain('financials');
		// Stopwords ("me", "the") are stripped from the seed query.
		expect(r.query).not.toContain(' me ');
	});

	it('fires on "please forward" and "could you share"', () => {
		expect(detectAttachmentRequest('Please forward the signed contract.').requested).toBe(true);
		expect(detectAttachmentRequest('Could you share your latest invoice with us?').requested).toBe(
			true,
		);
	});

	it('fires on "see attached" / "attached is" references', () => {
		expect(detectAttachmentRequest('See attached for the details.').requested).toBe(true);
		expect(detectAttachmentRequest('Attached is the proposal we discussed.').requested).toBe(true);
	});

	it('stays quiet on ordinary prose that merely mentions sending', () => {
		expect(detectAttachmentRequest('Thanks, I already sent the report last week.').requested).toBe(
			false,
		);
		expect(detectAttachmentRequest('We can meet on Tuesday to discuss pricing.').requested).toBe(
			false,
		);
		expect(detectAttachmentRequest('').requested).toBe(false);
	});
});

function candidate(id: string, score: number, over: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
	return { fileId: id, filename: `${id}.pdf`, score, ...over };
}

describe('pickAttachmentSuggestion', () => {
	it('returns nothing when there are no matches', () => {
		expect(pickAttachmentSuggestion([])).toEqual({ candidates: [], ambiguous: false });
	});

	it('suggests the only match (not ambiguous)', () => {
		const result = pickAttachmentSuggestion([candidate('a', 0.9)]);
		expect(result.ambiguous).toBe(false);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]!.fileId).toBe('a');
	});

	it('suggests only the top hit when it is clearly ahead (floor + margin)', () => {
		const top = MATCH_FLOOR + AMBIGUITY_MARGIN + 0.1;
		const result = pickAttachmentSuggestion([candidate('a', top), candidate('b', 0.1)]);
		expect(result.ambiguous).toBe(false);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]!.fileId).toBe('a');
	});

	it('is ambiguous when two matches are comparably strong (no clear winner)', () => {
		const result = pickAttachmentSuggestion([candidate('a', 0.62), candidate('b', 0.6)]);
		expect(result.ambiguous).toBe(true);
		expect(result.candidates.length).toBeGreaterThanOrEqual(2);
	});

	it('is ambiguous when the top hit is below the confidence floor', () => {
		const result = pickAttachmentSuggestion([candidate('a', 0.2), candidate('b', 0.05)]);
		expect(result.ambiguous).toBe(true);
	});

	it('caps the shortlist at MAX_CANDIDATES', () => {
		const files = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => candidate(`f${i}`, 0.5 - i * 0.01));
		const result = pickAttachmentSuggestion(files);
		expect(result.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
	});

	it('preserves extra candidate fields (generic over the row shape)', () => {
		type Rich = AttachmentCandidate & { storageId: string };
		const rows: Rich[] = [
			{ fileId: 'a', filename: 'a.pdf', score: 0.9, storageId: 'store_a' },
		];
		const result = pickAttachmentSuggestion(rows);
		expect(result.candidates[0]!.storageId).toBe('store_a');
	});
});
