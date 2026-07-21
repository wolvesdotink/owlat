import { describe, expect, it } from 'vitest';
import {
	ACKNOWLEDGED_ADVISORIES,
	classifyAuditJson,
	formatAuditClassification,
} from '../check-security-audit';

function auditEntry(
	severity: string,
	url: string,
	title = 'test advisory'
): Record<string, unknown[]> {
	return { example: [{ severity, url, title }] };
}

describe('security audit parser', () => {
	it('classifies an acknowledged advisory even when its URL has a trailing slash', () => {
		const raw = JSON.stringify(
			auditEntry('high', 'https://github.com/advisories/GHSA-mm7m-92g8-7m47/')
		);

		const result = classifyAuditJson(raw);

		expect(result.acknowledged).toHaveLength(1);
		expect(result.acknowledged[0]?.ghsa).toBe('GHSA-MM7M-92G8-7M47');
		expect(result.blocking).toHaveLength(0);
		expect(formatAuditClassification(result).exitCode).toBe(0);
	});

	it('blocks an unacknowledged high or critical advisory', () => {
		const high = classifyAuditJson(
			JSON.stringify(auditEntry('high', 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC'))
		);
		const critical = classifyAuditJson(
			JSON.stringify(auditEntry('critical', 'https://example.com/security/issue'))
		);

		expect(high.blocking).toHaveLength(1);
		expect(critical.blocking).toHaveLength(1);
		expect(formatAuditClassification(high).exitCode).toBe(1);
	});

	it('reports but does not block lower-severity advisories', () => {
		const result = classifyAuditJson(
			JSON.stringify(auditEntry('moderate', 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC'))
		);

		expect(result).toEqual({ acknowledged: [], blocking: [] });
		expect(formatAuditClassification(result).exitCode).toBe(0);
	});

	it('accepts an empty audit object as no findings', () => {
		expect(classifyAuditJson('{}')).toEqual({ acknowledged: [], blocking: [] });
	});

	it.each(['', '   ', '{not-json'])('fails closed for empty or malformed input: %p', (raw) => {
		expect(() => classifyAuditJson(raw)).toThrow(/failing closed/);
	});

	it.each(['[]', '{"example":{}}', '{"example":[{"severity":"high"}]}'])(
		'fails closed for an unexpected audit shape: %s',
		(raw) => {
			expect(() => classifyAuditJson(raw)).toThrow(/failing closed/);
		}
	);

	it('contains only acknowledgements that are still required by the lockfile policy', () => {
		expect(Object.keys(ACKNOWLEDGED_ADVISORIES)).toEqual(['GHSA-MM7M-92G8-7M47']);
	});
});
