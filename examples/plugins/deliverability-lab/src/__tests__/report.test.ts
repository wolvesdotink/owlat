import { describe, expect, it } from 'vitest';
import { analyzeEmail, summarizeFailure } from '../engine/report';
import {
	BROKEN_LINKS_EMAIL,
	CLEAN_EMAIL,
	INACCESSIBLE_EMAIL,
	SPAMMY_EMAIL,
} from './fixtures';

describe('analyzeEmail', () => {
	it('reports an overall pass only when every analyzer passes', () => {
		const report = analyzeEmail(CLEAN_EMAIL);
		expect(report.overall).toBe('pass');
		expect(report.findings).toHaveLength(0);
	});

	it.each([
		['spam', SPAMMY_EMAIL],
		['links', BROKEN_LINKS_EMAIL],
		['accessibility', INACCESSIBLE_EMAIL],
	])('reports overall fail when the %s analyzer fails', (_area, email) => {
		expect(analyzeEmail(email).overall).toBe('fail');
	});

	it('aggregates findings from every analyzer in a stable order', () => {
		const report = analyzeEmail(BROKEN_LINKS_EMAIL);
		expect(report.findings).toEqual([
			...report.spam.findings,
			...report.links.findings,
			...report.accessibility.findings,
		]);
	});

	it('summarizes only the disqualifying blockers for the gate objection', () => {
		const report = analyzeEmail(BROKEN_LINKS_EMAIL);
		const summary = summarizeFailure(report);
		expect(summary).toContain('Deliverability Lab held this send');
		expect(summary.length).toBeGreaterThan(0);
	});
});
