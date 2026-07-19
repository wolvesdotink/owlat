import { describe, expect, it } from 'vitest';
import { parseArgs, requireNoPositionals, requireSinglePositional } from '../args';
import { PluginCliError } from '../errors';

const spec = { booleans: ['dry-run', 'check'], values: ['name', 'dir'] } as const;

describe('parseArgs', () => {
	it('collects positionals, boolean switches, and valued options', () => {
		const parsed = parseArgs(['@acme/p', '--dry-run', '--dir', 'out'], spec);
		expect(parsed.positionals).toEqual(['@acme/p']);
		expect(parsed.booleans.has('dry-run')).toBe(true);
		expect(parsed.values.get('dir')).toBe('out');
	});

	it('accepts the --opt=value form', () => {
		const parsed = parseArgs(['--name=@acme/p'], spec);
		expect(parsed.values.get('name')).toBe('@acme/p');
	});

	it('rejects an unknown option', () => {
		expect(() => parseArgs(['--nope'], spec)).toThrow(PluginCliError);
	});

	it('rejects a value flag with no value', () => {
		expect(() => parseArgs(['--dir'], spec)).toThrow(/requires a value/);
	});

	it('refuses to swallow a following flag as a value', () => {
		// `--dir --dry-run` must not consume `--dry-run` as the `--dir` value and
		// silently defeat the switch; it fails loudly instead.
		expect(() => parseArgs(['--dir', '--dry-run'], spec)).toThrow(/requires a value/);
	});

	it('still allows a --opt=value that starts with -- as the escape hatch', () => {
		const parsed = parseArgs(['--dir=--weird'], spec);
		expect(parsed.values.get('dir')).toBe('--weird');
	});

	it('rejects a boolean flag given a value', () => {
		expect(() => parseArgs(['--dry-run=1'], spec)).toThrow(/does not take a value/);
	});
});

describe('positional guards', () => {
	it('requires exactly one positional', () => {
		expect(requireSinglePositional(parseArgs(['x'], spec), 'package name')).toBe('x');
		expect(() => requireSinglePositional(parseArgs([], spec), 'package name')).toThrow(
			/Missing required package name/
		);
		expect(() => requireSinglePositional(parseArgs(['a', 'b'], spec), 'package name')).toThrow(
			/exactly one/
		);
	});

	it('rejects stray positionals for argument-free commands', () => {
		expect(() => requireNoPositionals(parseArgs(['oops'], spec), 'codegen')).toThrow(
			/takes no positional/
		);
		expect(() => requireNoPositionals(parseArgs([], spec), 'codegen')).not.toThrow();
	});
});
