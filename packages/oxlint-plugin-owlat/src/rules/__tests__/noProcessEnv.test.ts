import rule from '../noProcessEnv.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = '/repo/apps/api/convex/delivery/poller.ts';
const options = [
	{
		files: ['apps/api/convex/**'],
		allow: [{ files: ['apps/api/convex/lib/env.ts'], reason: 'the one reader' }],
	},
];
const reported = { message: /^Read the environment through the env module/ };

ruleTester.run('owlat/no-process-env', rule, {
	valid: [
		{
			name: 'a read through the env module',
			filename,
			options,
			code: "const url = getOptional('SNDS_DATA_FEED_URLS') ?? '';",
		},
		{
			name: 'the env module itself, in every access form',
			filename: '/repo/apps/api/convex/lib/env.ts',
			options,
			code: 'const { NODE_ENV } = process.env;\nexport const get = (k: string) => process.env[k] ?? NODE_ENV;',
		},
		{
			name: 'test files configure a test run, not a deployment',
			filename: '/repo/apps/api/convex/delivery/__tests__/fixtures.ts',
			options,
			code: "const mode = process.env['OWLAT_RAMP_GATE_MATRIX_MODE'];",
		},
		{
			name: 'outside the configured files',
			filename: '/repo/apps/mta/src/config.ts',
			options,
			code: 'const port = process.env.PORT;',
		},
		{
			name: 'prose and strings',
			filename,
			options,
			code: "// process.env is off limits\nconst hint = 'process.env.FOO';",
		},
		{
			name: 'a local binding that shadows process',
			filename,
			options,
			code: 'function run(process: { env: string }) { return process.env; }',
		},
		{
			name: 'another member of process',
			filename,
			options,
			code: 'const cwd = process.cwd();\nconst { argv } = process;',
		},
		{
			name: 'an env property on something else',
			filename,
			options,
			code: 'const e = config.env;\nconst { env } = config;',
		},
		{
			name: 'other imports from node:process',
			filename,
			options,
			code: "import { argv } from 'node:process';\nimport { env } from './settings';",
		},
		{
			name: 'a non-global window.process',
			filename,
			options,
			code: 'const window = { process: { env: {} } };\nconst e = window.process.env;',
		},
	],
	invalid: [
		{
			name: 'a dotted read',
			filename,
			options,
			code: 'const url = process.env.SNDS_DATA_FEED_URLS;',
			errors: [reported],
		},
		{
			name: 'a bracket read with a literal key',
			filename,
			options,
			code: "const url = process.env['SNDS_DATA_FEED_URLS'];",
			errors: [reported],
		},
		{
			name: 'a bracket read with a computed key',
			filename,
			options,
			code: 'const url = process.env[`SNDS_${suffix}`];',
			errors: [reported],
		},
		{
			name: 'an optional-chained read',
			filename,
			options,
			code: 'const url = process.env?.SNDS_DATA_FEED_URLS;',
			errors: [reported],
		},
		{
			name: 'process reached by bracket',
			filename,
			options,
			code: "const url = process['env'].FOO;",
			errors: [reported],
		},
		{
			name: 'an enumeration',
			filename,
			options,
			code: 'const all = Object.entries(process.env);',
			errors: [reported],
		},
		{
			name: 'a destructured read',
			filename,
			options,
			code: 'const { SNDS_DATA_FEED_URLS } = process.env;',
			errors: [reported],
		},
		{
			name: 'env destructured from process',
			filename,
			options,
			code: "const { env } = process;\nconst { 'env': quoted } = process;",
			errors: [reported, reported],
		},
		{
			name: 'globalThis.process',
			filename,
			options,
			code: 'const url = globalThis.process.env.FOO;',
			errors: [reported],
		},
		{
			name: 'the process module, imported by name or as a whole',
			filename,
			options,
			code: [
				"import { env } from 'node:process';",
				"import proc from 'process';",
				"import * as nodeProcess from 'node:process';",
				'export const a = env.FOO;',
				'export const b = proc.env.FOO;',
				'export const c = nodeProcess.env.FOO;',
			].join('\n'),
			errors: [reported, reported, reported],
		},
	],
});
