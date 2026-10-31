import { describe, expect, it } from 'vitest';
import { parseDevStackArgs } from '../dev-stack/args';

describe('parseDevStackArgs', () => {
	it('defaults to up and keeps its flag', () => {
		expect(parseDevStackArgs([])).toEqual({
			kind: 'run',
			command: 'up',
			service: undefined,
			flags: new Set(),
		});
		expect(parseDevStackArgs(['--no-seed'])).toMatchObject({
			kind: 'run',
			command: 'up',
			flags: new Set(['--no-seed']),
		});
	});

	it('reads the logs service wherever the flag sits', () => {
		expect(parseDevStackArgs(['logs', '--follow', 'redis'])).toEqual({
			kind: 'run',
			command: 'logs',
			service: 'redis',
			flags: new Set(['--follow']),
		});
		expect(parseDevStackArgs(['logs'])).toMatchObject({ kind: 'run', service: undefined });
	});

	it.each([
		[['up', 'extra']],
		[['status', 'extra']],
		[['logs', 'convex', 'redis']],
		[['logs', 'web']],
		[['down', '--no-seed']],
		[['deploy']],
	])('rejects %j with usage and exit 2', (argv) => {
		expect(parseDevStackArgs(argv)).toEqual({ kind: 'usage', exitCode: 2 });
	});

	it.each([[['--help']], [['logs', '-h']], [['unknown', '--help']]])(
		'prints usage and exits 0 for %j',
		(argv) => {
			expect(parseDevStackArgs(argv)).toEqual({ kind: 'usage', exitCode: 0 });
		}
	);
});
