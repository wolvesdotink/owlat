import { join } from 'node:path';
import rule from '../convexErrorTaxonomy.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';
import { REPOSITORY_ROOT } from '../../__tests__/runOxlint.ts';

// Under the real convex/ tree, so the builder list is derived from the real
// lib/authedFunctions.ts and compositions (the file itself need not exist).
const filename = join(REPOSITORY_ROOT, 'apps/api/convex/workspaces/settingsFixture.ts');
const options = [
	{
		files: ['apps/api/convex/**'],
		allow: [{ files: ['apps/api/convex/_utils/errors.ts'], reason: 'the throw* helpers' }],
	},
];
const construction = { message: /^Throw through the coded helpers/ };
const bareThrow = (name: string, builder: string) => ({
	message: new RegExp(`^Bare Error thrown inside \`${name}\` \\(${builder}\\)`),
});

const IMPORTS = [
	"import { authedMutation, publicQuery } from '../lib/authedFunctions';",
	"import { postboxQuery as inbox } from '../mail/_helpers';",
	"import * as fns from '../lib/authedFunctions';",
	"import { internalMutation, mutation } from '../_generated/server';",
	"import { ConvexError } from 'convex/values';",
	'',
].join('\n');

const handler = (builder: string, body: string, name = 'rename') =>
	`${IMPORTS}export const ${name} = ${builder}({\n\targs: {},\n\thandler: async (ctx, args) => {\n\t\t${body}\n\t\treturn null;\n\t},\n});\n`;

const THROW = "if (!args.name) throw new Error('A name is required');";

ruleTester.run('owlat/convex-error-taxonomy', rule, {
	valid: [
		{
			name: 'ConvexError constructed in the errors module',
			filename: join(REPOSITORY_ROOT, 'apps/api/convex/_utils/errors.ts'),
			options,
			code: "import { ConvexError } from 'convex/values';\nexport const fail = () => { throw new ConvexError({ category: 'internal', message: 'x' }); };",
		},
		{
			name: 'catching a ConvexError',
			filename,
			options,
			code: `${IMPORTS}export const isCoded = (error: unknown) => error instanceof ConvexError;`,
		},
		{
			name: 'a bare throw in an internal function',
			filename,
			options,
			code: handler('internalMutation', THROW),
		},
		{
			name: 'a bare throw in a plain helper',
			filename,
			options,
			code: "function assertName(name: string) {\n\tif (!name) throw new Error('A name is required');\n}",
		},
		{
			name: 'the taxonomy thrower',
			filename,
			options,
			code: handler('authedMutation', "if (!args.name) throwInvalidInput('A name is required');"),
		},
		{
			name: 'a local Error class is not the global',
			filename,
			options,
			code: handler('authedMutation', "class Error {}\n\t\tthrow new Error('x');"),
		},
		{
			name: 'rethrowing a caught error',
			filename,
			options,
			code: handler('authedMutation', 'try { run(); } catch (error) { throw error; }'),
		},
		{
			name: 'a subclass of Error',
			filename,
			options,
			code: handler('authedMutation', "throw new TypeError('x');"),
		},
		{
			name: 'test files',
			filename: join(REPOSITORY_ROOT, 'apps/api/convex/__tests__/thing.test.ts'),
			options,
			code: handler('authedMutation', THROW),
		},
		{
			name: 'a definition that is never exported is not registered',
			filename,
			options,
			code: `${IMPORTS}const draft = authedMutation({ args: {}, handler: async () => { throw new Error('x'); } });`,
		},
		{
			name: 'a file outside any Convex tree',
			filename: '/repo/apps/api/convex/thing.ts',
			options,
			code: handler('authedMutation', THROW),
		},
	],
	invalid: [
		{
			name: 'a hand-rolled ConvexError, aliased or not',
			filename,
			options,
			code: [
				"import { ConvexError as Coded } from 'convex/values';",
				"import * as values from 'convex/values';",
				"export const a = () => { throw new Coded({ code: 'NOPE' }); };",
				"export const b = () => { throw new values.ConvexError({ code: 'NOPE' }); };",
			].join('\n'),
			errors: [construction, construction],
		},
		{
			name: 'a ConvexError subclass',
			filename,
			options,
			code: `${IMPORTS}export class Refused extends ConvexError<{ code: string }> {}\nexport const Other = class extends ConvexError<string> {};`,
			errors: [construction, construction],
		},
		{
			name: 'a bare throw in an authedMutation',
			filename,
			options,
			code: handler('authedMutation', THROW),
			errors: [bareThrow('rename', 'authedMutation')],
		},
		{
			name: 'a bare throw in a publicQuery',
			filename,
			options,
			code: handler('publicQuery', THROW),
			errors: [bareThrow('rename', 'publicQuery')],
		},
		{
			name: 'a composed builder imported under an alias',
			filename,
			options,
			code: handler('inbox', THROW),
			errors: [bareThrow('rename', 'postboxQuery')],
		},
		{
			name: 'a builder reached through a namespace import',
			filename,
			options,
			code: handler('fns.authedMutation', THROW),
			errors: [bareThrow('rename', 'authedMutation')],
		},
		{
			name: 'the raw builder',
			filename,
			options,
			code: handler('mutation', THROW),
			errors: [bareThrow('rename', 'mutation')],
		},
		{
			name: 'Error called without new, and a throw in a nested helper',
			filename,
			options,
			code: handler(
				'authedMutation',
				"const check = () => { throw Error('nested'); };\n\t\tcheck();"
			),
			errors: [bareThrow('rename', 'authedMutation')],
		},
		{
			name: 'a local alias of a builder and a file-local composition',
			filename,
			options,
			code: [
				IMPORTS,
				'const write = authedMutation;',
				"const assistantQuery = featureGated(authedQuery, 'ai.assistant');",
				`export const a = write({ args: {}, handler: async () => { throw new Error('a'); } });`,
				`export const b = assistantQuery({ args: {}, handler: async () => { throw new Error('b'); } });`,
			].join('\n'),
			errors: [bareThrow('a', 'authedMutation'), bareThrow('b', 'assistantQuery')],
		},
		{
			name: 'export by specifier and export default',
			filename,
			options,
			code: [
				IMPORTS,
				"const local = authedMutation({ args: {}, handler: async () => { throw new Error('a'); } });",
				'export { local as renamed };',
				"export default publicQuery({ args: {}, handler: async () => { throw new Error('b'); } });",
			].join('\n'),
			errors: [bareThrow('renamed', 'authedMutation'), bareThrow('default', 'publicQuery')],
		},
		{
			name: 'a definition the formatter wrapped and closed off column 0',
			filename,
			options,
			code: `${IMPORTS}export const wrapped =\n\tauthedMutation({\n\t\targs: {},\n\t\thandler: async () => {\n\t\t\tthrow new Error('x');\n\t\t},\n\t});\n`,
			errors: [bareThrow('wrapped', 'authedMutation')],
		},
	],
});
