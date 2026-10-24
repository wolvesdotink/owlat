import { describe, expect, it } from 'vitest';
import { runBounded, type CommandOptions } from '../boundedCommand';

describe('runBounded', () => {
	const node = process.execPath;
	const options = (overrides: Partial<CommandOptions>): CommandOptions => ({
		cwd: process.cwd(),
		timeoutMs: 30_000,
		maxBytes: 1024,
		keep: 'head',
		...overrides,
	});
	const print =
		'for (let i = 0; i < 2000; i++) console.log("line " + i); console.error("on stderr");';

	it('keeps the head of an oversized output and reports the cut', async () => {
		const result = await runBounded(node, ['-e', print], options({ maxBytes: 64 }));
		expect(result.code).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBe(64);
		expect(result.output.startsWith('line 0\n')).toBe(true);
		expect(result.output).not.toContain('on stderr');
	});

	it('keeps the tail, starting at a whole line', async () => {
		const result = await runBounded(node, ['-e', print], options({ maxBytes: 64, keep: 'tail' }));
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(64);
		expect(result.output).toMatch(/^line \d+\n/);
		expect(result.output.endsWith('line 1999\n')).toBe(true);
	});

	it('captures stderr too when asked', async () => {
		const result = await runBounded(
			node,
			['-e', 'console.error("only stderr")'],
			options({ mergeStderr: true })
		);
		expect(result).toMatchObject({ code: 0, output: 'only stderr\n', truncated: false });
	});

	it('reports a program that cannot start as 127', async () => {
		const result = await runBounded('owlat-no-such-program', [], options({}));
		expect(result).toEqual({ code: 127, output: '', truncated: false, timedOut: false });
	});

	it('passes the exit code through', async () => {
		const result = await runBounded(node, ['-e', 'process.exit(3)'], options({}));
		expect(result).toMatchObject({ code: 3, truncated: false, timedOut: false });
	});
});
