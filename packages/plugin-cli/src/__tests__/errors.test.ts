import { PLUGIN_CODEGEN_ERROR_HINTS, PluginCodegenError } from '@owlat/plugin-codegen';
import { describe, expect, it } from 'vitest';
import { PluginCliError, reportCliFailure } from '../errors';
import { captureIo } from './fixtures';

describe('reportCliFailure', () => {
	it('prints a PluginCliError headline followed by its indented details', () => {
		const { io, errors } = captureIo();
		reportCliFailure(io, new PluginCliError('bad config', ['first hint', 'second hint']));
		expect(errors).toEqual(['bad config', '  first hint', '  second hint']);
	});

	it('prints a codegen failure with its code, its details and what to do next', () => {
		const { io, errors } = captureIo();
		reportCliFailure(
			io,
			new PluginCodegenError('dependency_missing', 'codegen failed', [
				'the package is not installed',
			])
		);
		expect(errors).toEqual([
			'codegen failed [dependency_missing]',
			'  the package is not installed',
			`Next: ${PLUGIN_CODEGEN_ERROR_HINTS.dependency_missing}`,
		]);
	});

	it('keeps the code and the hint when a command re-wraps a codegen failure', () => {
		const { io, errors } = captureIo();
		const cause = new PluginCodegenError('invalid_manifest', 'bad manifest', ['$.id is missing']);
		reportCliFailure(io, new PluginCliError(cause.message, cause.details, { cause }));
		expect(errors).toEqual([
			'bad manifest [invalid_manifest]',
			'  $.id is missing',
			`Next: ${PLUGIN_CODEGEN_ERROR_HINTS.invalid_manifest}`,
		]);
	});

	it('prints an unexpected error by its first message line and the frame that threw', () => {
		const { io, errors } = captureIo();
		const error = new Error('cannot read chunk\nsecond line with file contents');
		error.stack = 'Error: cannot read chunk\n    at readChunk (/workspace/src/config.ts:3:1)';
		reportCliFailure(io, error);
		expect(errors).toEqual([
			'Failed unexpectedly: Error: cannot read chunk',
			'  at readChunk (/workspace/src/config.ts:3:1)',
			'This is a bug in the plugin tooling. Report it with the lines above.',
		]);
	});
});
