import { describe, expect, it } from 'vitest';
import { compareWarnings, warningKey } from '../check-lint-warnings';

describe('lint warning ratchet', () => {
	it('passes when every live count matches its baseline exactly', () => {
		expect(compareWarnings({ a: 2, b: 1 }, { a: 2, b: 1 })).toEqual({
			regressions: [],
			stale: [],
		});
	});

	it('rejects a new warning and an increased count', () => {
		expect(compareWarnings({ old: 2, new: 1 }, { old: 1 })).toEqual({
			regressions: ['old: 2 warnings (baseline 1)', 'new: 1 warnings (baseline 0)'],
			stale: [],
		});
	});

	it('rejects a lowered count until its baseline is lowered too', () => {
		expect(compareWarnings({ old: 1 }, { old: 2 })).toEqual({
			regressions: [],
			stale: ['old: 1 warnings (baseline 2)'],
		});
	});

	it('rejects a baseline key whose warnings are all gone', () => {
		expect(compareWarnings({}, { removed: 1 })).toEqual({
			regressions: [],
			stale: ['removed: 0 warnings (baseline 1)'],
		});
	});

	it('reports a regression and a stale key from the same run', () => {
		expect(compareWarnings({ kept: 1, new: 1 }, { kept: 1, removed: 3 })).toEqual({
			regressions: ['new: 1 warnings (baseline 0)'],
			stale: ['removed: 0 warnings (baseline 3)'],
		});
	});

	it('keys diagnostics by UTF-8 token instead of moving line numbers', () => {
		const source = Buffer.from('😀import "./cycle"');
		const diagnostic = {
			filename: 'src/a.ts',
			code: 'import(no-cycle)',
			message: 'Cycle',
			severity: 'warning',
			labels: [{ span: { offset: 11, length: 9 } }],
		};
		expect(JSON.parse(warningKey(diagnostic, source)).at(-1)).toBe('"./cycle"');
		expect(warningKey(diagnostic, source)).not.toBe(
			warningKey({ ...diagnostic, filename: 'src/b.ts' }, source)
		);
	});
});
