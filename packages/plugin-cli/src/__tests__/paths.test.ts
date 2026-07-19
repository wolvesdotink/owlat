import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPosix } from '../paths';

describe('toPosix', () => {
	it('leaves a POSIX (/-separated) display path unchanged', () => {
		expect(toPosix('a/b/c')).toBe('a/b/c');
		expect(toPosix('.')).toBe('.');
		expect(toPosix('')).toBe('');
	});

	it('joins native-separator segments with /', () => {
		const native = ['plugins', 'my-plugin', 'README.md'].join(sep);
		expect(toPosix(native)).toBe('plugins/my-plugin/README.md');
	});

	it('is stable under repeated application', () => {
		const once = toPosix(['a', 'b'].join(sep));
		expect(toPosix(once)).toBe(once);
	});
});
