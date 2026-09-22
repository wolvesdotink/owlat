import { describe, expect, it } from 'vitest';
import { excessWarnings, warningKey } from '../check-lint-warnings';

describe('lint warning ratchet', () => {
	it('rejects a new warning and an increased count, but permits reductions', () => {
		expect(excessWarnings({ old: 2, new: 1 }, { old: 1 })).toHaveLength(2);
		expect(excessWarnings({ old: 1 }, { old: 2, removed: 1 })).toEqual([]);
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
