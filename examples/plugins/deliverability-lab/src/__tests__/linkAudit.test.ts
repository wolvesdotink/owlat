import { describe, expect, it } from 'vitest';
import { auditLinks } from '../engine/linkAudit';
import { BROKEN_LINKS_EMAIL, CLEAN_EMAIL } from './fixtures';

describe('auditLinks', () => {
	it('passes a message whose links are https with UTM tags', () => {
		const report = auditLinks(CLEAN_EMAIL);
		expect(report.verdict).toBe('pass');
		expect(report.linkCount).toBe(1);
		expect(report.findings).toHaveLength(0);
	});

	it('flags insecure http and bare-IP links as blockers', () => {
		const report = auditLinks(BROKEN_LINKS_EMAIL);
		expect(report.verdict).toBe('fail');
		const codes = report.findings.map((finding) => finding.code);
		expect(codes).toContain('insecure_link');
		expect(codes).toContain('bare_host_link');
	});

	it('warns (not fails) when a tracked link is missing utm parameters', () => {
		const report = auditLinks({
			from: 'a@b.example',
			subject: 'hi',
			html: '<p><a href="https://aster.example/x">link</a></p>',
		});
		expect(report.verdict).toBe('warn');
		expect(report.findings.map((finding) => finding.code)).toContain('missing_utm');
	});

	it('flags a display/target mismatch where the visible URL differs from the href', () => {
		const report = auditLinks({
			from: 'a@b.example',
			subject: 'hi',
			html: '<p><a href="https://evil.example/login?utm_source=n">https://bank.example</a></p>',
		});
		expect(report.findings.map((finding) => finding.code)).toContain('display_target_mismatch');
	});

	it('ignores in-page anchors and treats a message with no HTML as clean', () => {
		expect(auditLinks({ from: 'a@b.example', subject: 'hi', text: 'no links' }).verdict).toBe(
			'pass'
		);
		const anchorOnly = auditLinks({
			from: 'a@b.example',
			subject: 'hi',
			html: '<a href="#section">jump</a>',
		});
		expect(anchorOnly.linkCount).toBe(0);
		expect(anchorOnly.verdict).toBe('pass');
	});
});
