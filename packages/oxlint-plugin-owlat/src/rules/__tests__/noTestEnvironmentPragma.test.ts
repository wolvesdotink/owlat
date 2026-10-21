import rule from '../noTestEnvironmentPragma.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

// Vitest scans this file's own text for the pragma, so the cases build it from
// a tag that no environment word follows here.
const TAG = '@vitest-environment';
const JEST_TAG = '@jest-environment';

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
const reported = (environment: string) => ({
	message: new RegExp(`^Drop this \`${TAG} ${environment}\` pragma`),
});

ruleTester.run('owlat/no-test-environment-pragma', rule, {
	valid: [
		{ name: 'a test file without a pragma', filename, code: "import { it } from 'vitest';" },
		{
			name: 'a pragma the options allow for this exact file',
			filename,
			code: `/** ${TAG} node */\nexport {};`,
			options: allow,
		},
		{
			name: 'a pragma the options allow for the whole package (any depth)',
			filename: '/repo/packages/email-builder/src/components/__tests__/Block.test.ts',
			code: `// ${TAG} happy-dom\nexport {};`,
			options: allow,
		},
		{
			name: 'a single-segment glob',
			filename: '/repo/apps/web/e2e/seed.test.ts',
			code: `// ${TAG} node\nexport {};`,
			options: allow,
		},
		{
			name: 'a single-character wildcard',
			filename: '/repo/apps/web/e2e/seed1.test.ts',
			code: `// ${TAG} node\nexport {};`,
			options: [{ allow: [{ environment: 'node', files: ['apps/web/e2e/seed?.test.ts'] }] }],
		},
		{
			name: 'a Windows path',
			filename: 'C:\\repo\\packages\\email-builder\\src\\x.test.ts',
			code: `// ${TAG} happy-dom\nexport {};`,
			options: allow,
		},
		{
			name: 'prose that quotes the tag with no environment word after it',
			filename,
			code: `// Do not add a \`${TAG}\` pragma here.\nexport {};`,
		},
		{
			name: 'the environment options pragma, which selects no environment',
			filename,
			code: `// ${TAG}-options {"url": "https://owlat.example"}\nexport {};`,
		},
	],
	invalid: [
		{
			name: 'a docblock pragma with no allowance',
			filename,
			code: `/**\n * ${TAG} happy-dom\n */\nexport {};`,
			errors: [{ ...reported('happy-dom'), line: 2, column: 3, endLine: 2, endColumn: 32 }],
		},
		{
			name: 'a pragma in the middle of a prose comment, which vitest still reads',
			filename,
			code: `// This test uses ${TAG} node on purpose.\nexport {};`,
			errors: [reported('node')],
		},
		{
			name: 'a pragma inside a string, which vitest still reads',
			filename,
			code: `const doc = '/** ${TAG} node */';`,
			errors: [reported('node')],
		},
		{
			name: 'a pragma inside a template literal, which vitest still reads',
			filename,
			code: `const doc = \`${TAG} happy-dom\`;`,
			errors: [reported('happy-dom')],
		},
		{
			name: 'the environment word on the next line',
			filename,
			code: `// ${TAG}\n// node\nconst x = 1; // ${TAG}\nnode;`,
			errors: [reported('node')],
		},
		{
			name: 'every pragma in the file, since removing one promotes the next',
			filename,
			code: `// ${TAG} node\n// ${TAG} happy-dom\nexport {};`,
			options: allow,
			errors: [reported('happy-dom')],
		},
		{
			name: 'an environment allowed only for other files',
			filename: '/repo/apps/web/app/__tests__/other.test.ts',
			code: `/** ${TAG} node */\nexport {};`,
			options: allow,
			errors: 1,
		},
		{
			name: 'a different environment than the file is allowed',
			filename: '/repo/packages/email-builder/src/x.test.ts',
			code: `// ${TAG} node\nexport {};`,
			options: allow,
			errors: 1,
		},
		{
			name: 'a single-segment glob does not cross directories',
			filename: '/repo/apps/web/e2e/nested/seed.test.ts',
			code: `// ${TAG} node\nexport {};`,
			options: allow,
			errors: 1,
		},
		{
			name: 'a path that only ends with the allowed name inside a segment',
			filename: '/repo/apps/web/app/__tests__/big-widget.test.ts',
			code: `// ${TAG} node\nexport {};`,
			options: [{ allow: [{ environment: 'node', files: ['widget.test.ts'] }] }],
			errors: 1,
		},
		{
			name: 'a jest-style pragma',
			filename,
			code: `// ${JEST_TAG} node\nexport {};`,
			errors: [reported('node')],
		},
	],
});
