import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareStrings, toPosix } from '../paths';

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

describe('compareStrings', () => {
	it('orders strings ascending lexicographically', () => {
		expect(compareStrings('a', 'b')).toBeLessThan(0);
		expect(compareStrings('b', 'a')).toBeGreaterThan(0);
		expect(compareStrings('a', 'a')).toBe(0);
	});

	it('sorts a set of all-ASCII domain values identically to the default sort', () => {
		const values = [
			'@owlat/plugin-zeta',
			'@owlat/plugin-alpha',
			'plugins/my-plugin/README.md',
			'mail.send:outbound',
			'inbox.read:all',
		];
		expect([...values].sort(compareStrings)).toEqual([...values].sort());
	});
});
