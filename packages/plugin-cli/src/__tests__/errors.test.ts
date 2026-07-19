import { PluginCodegenError } from '@owlat/plugin-codegen';
import { describe, expect, it } from 'vitest';
import { PluginCliError, reportCliFailure } from '../errors';
import { captureIo } from './fixtures';

describe('reportCliFailure', () => {
	it('prints a PluginCliError headline followed by its indented details', () => {
		const { io, errors } = captureIo();
		reportCliFailure(
			io,
			new PluginCliError('bad config', ['first hint', 'second hint']),
			'fallback'
		);
		expect(errors).toEqual(['bad config', '  first hint', '  second hint']);
	});

	it('unwraps a PluginCodegenError to the same message + indented details shape', () => {
		const { io, errors } = captureIo();
		reportCliFailure(
			io,
			new PluginCodegenError('config_invalid', 'codegen failed', ['fix the manifest']),
			'fallback'
		);
		expect(errors).toEqual(['codegen failed', '  fix the manifest']);
	});

	it('prints only the fallback for an unexpected error, leaking no cause', () => {
		const { io, errors } = captureIo();
		reportCliFailure(io, new Error('secret internal detail'), 'unexpected failure');
		expect(errors).toEqual(['unexpected failure']);
	});
});
