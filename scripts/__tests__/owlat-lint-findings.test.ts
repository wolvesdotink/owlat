import { describe, expect, it } from 'vitest';
import { isOwlatWarning, ratchetedWarnings } from '../check-lint-warnings';
import { findingLine } from '../owlat-lint-findings';

const finding = (offset: number, length: number) => ({
	filename: 'apps/web/app/x.test.ts',
	code: 'owlat(no-test-in-loop)',
	message: 'Do not declare it(…) inside a loop.',
	severity: 'warning',
	labels: [{ span: { offset, length } }],
});

describe('owlat lint ratchet lines', () => {
	it('key a finding by file, rule and the reported UTF-8 source, not its position', () => {
		const source = Buffer.from('// 😀\nfor (const n of ns) it(`a ${n}`, f);');
		const offset = source.indexOf('it(');
		expect(findingLine(finding(offset, 2), source)).toBe(
			'apps/web/app/x.test.ts\towlat(no-test-in-loop)\tit'
		);
		const shifted = Buffer.concat([Buffer.from('\n\n'), source]);
		expect(findingLine(finding(offset + 2, 2), shifted)).toBe(
			findingLine(finding(offset, 2), source)
		);
	});

	it('fold a multi-line span onto one line and bound its length', () => {
		const source = Buffer.from(`/**\n * folded onto one line\n${'x'.repeat(400)} */`);
		const line = findingLine(finding(0, source.length), source);
		expect(line.split('\n')).toHaveLength(1);
		expect(line.split('\t')[2]).toMatch(/^\/\*\* \* folded onto one line x+$/);
		expect(line.split('\t')[2]!.length).toBe(160);
	});
});

describe('owlat warnings have one owner', () => {
	it('are ratcheted here, while owlat errors and other warnings are not', () => {
		expect(isOwlatWarning({ code: 'owlat(no-test-in-loop)', severity: 'warning' })).toBe(true);
		expect(isOwlatWarning({ code: 'owlat(no-test-in-loop)', severity: 'error' })).toBe(false);
		expect(isOwlatWarning({ code: 'import(no-cycle)', severity: 'warning' })).toBe(false);
		expect(isOwlatWarning({ severity: 'error' })).toBe(false);
	});

	it('are left out of the lint warning ratchet, which keeps every other warning', () => {
		const other = { ...finding(0, 1), code: 'import(no-cycle)' };
		const enforced = { ...finding(0, 1), severity: 'error' };
		expect(ratchetedWarnings([finding(0, 1), other, enforced])).toEqual([other]);
	});
});
