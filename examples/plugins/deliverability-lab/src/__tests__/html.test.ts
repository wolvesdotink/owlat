import { describe, expect, it } from 'vitest';
import { analyzeEmail } from '../engine';
import { MAX_SCAN_LENGTH, scanAnchors, scanTags, textContent } from '../engine/html';

/**
 * The scanners regex-tokenize an untrusted email body and can backtrack
 * super-linearly on adversarial input (an unclosed tag opener). They defend
 * against that by clamping to the first `MAX_SCAN_LENGTH` characters, which makes
 * the worst case a constant regardless of body size. These tests pin that cap
 * DETERMINISTICALLY — by equality against the scan of the capped prefix, not by
 * timing — so they cannot flake on a slow machine while still proving the bound.
 */
describe('scanner input cap (MAX_SCAN_LENGTH)', () => {
	it('scanTags of an over-cap body equals scanTags of its capped prefix', () => {
		// A well-formed repeated tag: content beyond the cap must be ignored.
		const unit = '<a href="https://x">hi</a>';
		const body = unit.repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / unit.length));
		expect(body.length).toBeGreaterThan(MAX_SCAN_LENGTH);
		expect(scanTags(body)).toEqual(scanTags(body.slice(0, MAX_SCAN_LENGTH)));
	});

	it('scanAnchors of an over-cap body equals scanAnchors of its capped prefix', () => {
		const unit = '<a href="https://x">hi</a>';
		const body = unit.repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / unit.length));
		expect(scanAnchors(body)).toEqual(scanAnchors(body.slice(0, MAX_SCAN_LENGTH)));
	});

	it('textContent of an over-cap body equals textContent of its capped prefix', () => {
		const body = 'word '.repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / 5));
		expect(textContent(body)).toEqual(textContent(body.slice(0, MAX_SCAN_LENGTH)));
	});

	it('still returns a report on an over-cap adversarial unclosed-tag body', () => {
		// `'<a "'.repeat(n)` is the pathological quadratic input for TAG_RE; here it is
		// several times the cap. The correctness property is that the scan is bounded
		// to the fixed prefix (proven deterministically by the equality cases above),
		// so analyzeEmail returns a well-formed report rather than pinning a CPU on the
		// unbounded body. Analyzing only the prefix must match analyzing the full body.
		const adversarial = '<a "'.repeat(MAX_SCAN_LENGTH);
		expect(adversarial.length).toBeGreaterThan(MAX_SCAN_LENGTH);
		const email = { from: 'sender@example.com', subject: 'Adversarial body' };
		const report = analyzeEmail({ ...email, html: adversarial });
		expect(report.overall).toMatch(/^(pass|warn|fail)$/);
		expect(report).toEqual(analyzeEmail({ ...email, html: adversarial.slice(0, MAX_SCAN_LENGTH) }));
	});
});
