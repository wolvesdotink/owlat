import rule from '../noTestEnvironmentPragma.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = '/repo/apps/web/app/__tests__/widget.test.ts';
const allow = [
	{
		allow: [
			{ environment: 'happy-dom', files: ['packages/email-builder/**'] },
			{
				environment: 'node',
				files: ['apps/web/app/__tests__/widget.test.ts', 'apps/web/e2e/*.test.ts'],
			},
		],
	},
];

ruleTester.run('owlat/no-test-environment-pragma', rule, {
	valid: [
		{ name: 'a test file without a pragma', filename, code: "import { it } from 'vitest';" },
		{
			name: 'a pragma the options allow for this exact file',
			filename,
			code: '/** @vitest-environment node */\nexport {};',
			options: allow,
		},
		{
			name: 'a pragma the options allow for the whole package (any depth)',
			filename: '/repo/packages/email-builder/src/components/__tests__/Block.test.ts',
			code: '// @vitest-environment happy-dom\nexport {};',
			options: allow,
		},
		{
			name: 'a single-segment glob',
			filename: '/repo/apps/web/e2e/seed.test.ts',
			code: '// @vitest-environment node\nexport {};',
			options: allow,
		},
		{
			name: 'a single-character wildcard',
			filename: '/repo/apps/web/e2e/seed1.test.ts',
			code: '// @vitest-environment node\nexport {};',
			options: [{ allow: [{ environment: 'node', files: ['apps/web/e2e/seed?.test.ts'] }] }],
		},
		{
			name: 'a Windows path',
			filename: 'C:\\repo\\packages\\email-builder\\src\\x.test.ts',
			code: '// @vitest-environment happy-dom\nexport {};',
			options: allow,
		},
		{
			name: 'prose that mentions the pragma mid-sentence',
			filename,
			code: '// Do not add a @vitest-environment pragma here.\nexport {};',
		},
		{
			name: 'the pragma text inside a string',
			filename,
			code: "const doc = '/** @vitest-environment node */';",
		},
	],
	invalid: [
		{
			name: 'a docblock pragma with no allowance',
			filename,
			code: '/**\n * @vitest-environment happy-dom\n */\nexport {};',
			errors: [{ message: /`@vitest-environment happy-dom`/ }],
		},
		{
			name: 'an environment allowed only for other files',
			filename: '/repo/apps/web/app/__tests__/other.test.ts',
			code: '/** @vitest-environment node */\nexport {};',
			options: allow,
			errors: 1,
		},
		{
			name: 'a different environment than the file is allowed',
			filename: '/repo/packages/email-builder/src/x.test.ts',
			code: '// @vitest-environment node\nexport {};',
			options: allow,
			errors: 1,
		},
		{
			name: 'a single-segment glob does not cross directories',
			filename: '/repo/apps/web/e2e/nested/seed.test.ts',
			code: '// @vitest-environment node\nexport {};',
			options: allow,
			errors: 1,
		},
		{
			name: 'a path that only ends with the allowed name inside a segment',
			filename: '/repo/apps/web/app/__tests__/big-widget.test.ts',
			code: '// @vitest-environment node\nexport {};',
			options: [{ allow: [{ environment: 'node', files: ['widget.test.ts'] }] }],
			errors: 1,
		},
		{
			name: 'a jest-style pragma',
			filename,
			code: '// @jest-environment node\nexport {};',
			errors: [{ message: /`@vitest-environment node`/ }],
		},
	],
});
