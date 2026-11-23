import { describe, expect, it } from 'vitest';
import {
	formatPluginCodegenFailure,
	PLUGIN_CODEGEN_ERROR_HINTS,
	PluginCodegenError,
} from '../errors';

describe('formatPluginCodegenFailure', () => {
	it('prints the code, the message, each detail and what to do next', () => {
		const error = new PluginCodegenError(
			'invalid_manifest',
			'Bundled plugin @acme/plugin does not export a valid default manifest',
			[
				'$.secret is not supported',
				'$.id must be a lowercase kebab-case id of at most 64 characters',
			]
		);

		expect(formatPluginCodegenFailure(error)).toEqual([
			'Bundled plugin @acme/plugin does not export a valid default manifest [invalid_manifest]',
			'  $.secret is not supported',
			'  $.id must be a lowercase kebab-case id of at most 64 characters',
			`Next: ${PLUGIN_CODEGEN_ERROR_HINTS.invalid_manifest}`,
		]);
	});

	it('gives every code a one-line hint', () => {
		for (const [code, hint] of Object.entries(PLUGIN_CODEGEN_ERROR_HINTS)) {
			expect(hint.length, code).toBeGreaterThan(0);
			expect(hint, code).not.toContain('\n');
		}
	});

	it('prints an unexpected error with its first message line and the frame that threw', () => {
		const error = new RangeError('offset out of range\nfile contents that must not print');
		error.stack = [
			'RangeError: offset out of range',
			'file contents that must not print',
			'    at readChunk (/workspace/packages/plugin-codegen/src/render.ts:12:3)',
			'    at main (/workspace/packages/plugin-codegen/src/cli.ts:4:1)',
		].join('\n');

		const lines = formatPluginCodegenFailure(error);

		expect(lines).toEqual([
			'Failed unexpectedly: RangeError: offset out of range',
			'  at readChunk (/workspace/packages/plugin-codegen/src/render.ts:12:3)',
			'This is a bug in the plugin tooling. Report it with the lines above.',
		]);
		expect(lines.join('\n')).not.toContain('must not print');
	});
});
