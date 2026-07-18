import { describe, expect, it } from 'vitest';
import { auditAccessibility } from '../engine/accessibility';
import { CLEAN_EMAIL, INACCESSIBLE_EMAIL } from './fixtures';

describe('auditAccessibility', () => {
	it('passes a message with alt text, a lang attribute, and labelled links', () => {
		const report = auditAccessibility(CLEAN_EMAIL);
		expect(report.verdict).toBe('pass');
		expect(report.findings).toHaveLength(0);
	});

	it('flags an image with no alt attribute and an empty-text link as blockers', () => {
		const report = auditAccessibility(INACCESSIBLE_EMAIL);
		expect(report.verdict).toBe('fail');
		const codes = report.findings.map((finding) => finding.code);
		expect(codes).toContain('img_missing_alt');
		expect(codes).toContain('empty_link_text');
	});

	it('warns when the document has no lang attribute', () => {
		const report = auditAccessibility({
			from: 'a@b.example',
			subject: 'hi',
			html: '<body><p>hello</p></body>',
		});
		expect(report.findings.map((finding) => finding.code)).toContain('missing_lang');
		expect(report.verdict).toBe('warn');
	});

	it('does not flag an image-wrapping link that carries alt text', () => {
		const report = auditAccessibility({
			from: 'a@b.example',
			subject: 'hi',
			html: '<html lang="en"><a href="https://x.example"><img src="x.png" alt="Open" /></a></html>',
		});
		expect(report.findings.map((finding) => finding.code)).not.toContain('empty_link_text');
	});

	it('treats a message with no HTML as clean', () => {
		expect(
			auditAccessibility({ from: 'a@b.example', subject: 'hi', text: 'plain' }).verdict
		).toBe('pass');
	});
});
