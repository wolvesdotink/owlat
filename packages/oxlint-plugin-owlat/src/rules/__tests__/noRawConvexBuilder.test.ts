import rule from '../noRawConvexBuilder.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = '/repo/apps/api/convex/contacts/list.ts';
const options = [
	{
		files: ['apps/api/convex/**'],
		allow: [
			{ files: ['apps/api/convex/lib/authedFunctions.ts'], reason: 'defines the safe builders' },
		],
	},
];
const raw = (name: string) => ({ message: new RegExp(`^\`${name}\` is a raw Convex builder`) });

ruleTester.run('owlat/no-raw-convex-builder', rule, {
	valid: [
		{
			name: 'the wrapper module defines the safe builders on the raw ones',
			filename: '/repo/apps/api/convex/lib/authedFunctions.ts',
			options,
			code: "import { query } from '../_generated/server';\nexport const authedQuery = query;",
		},
		{
			name: 'the secure-by-default, internal and HTTP builders',
			filename,
			options,
			code: [
				"import { authedQuery } from '../lib/authedFunctions';",
				"import { internalQuery, httpAction } from '../_generated/server';",
				"import { httpRouter, internalQueryGeneric } from 'convex/server';",
				'export const list = authedQuery({ args: {}, handler: async (ctx) => ctx.db.query("contacts").collect() });',
				'export const sync = internalQuery({ args: {}, handler: async () => null });',
				'export const hook = httpAction(async () => new Response());',
				'export const router = httpRouter();',
				'export const generic = internalQueryGeneric;',
			].join('\n'),
		},
		{
			name: 'a local function named query and an unrelated namespace',
			filename,
			options,
			code: "import * as helpers from './helpers';\nconst query = (q: string) => q;\nexport const x = query('a');\nexport const y = helpers.query('b');",
		},
		{
			name: 'a namespace import used for its safe members',
			filename,
			options,
			code: "import * as server from '../_generated/server';\nexport const sync = server.internalQuery({ args: {}, handler: async () => null });",
		},
		{
			name: 'test files',
			filename: '/repo/apps/api/convex/__tests__/x.test.ts',
			options,
			code: "import { query } from '../_generated/server';\nexport const q = query({});",
		},
		{
			name: 'outside convex/',
			filename: '/repo/apps/web/app/x.ts',
			options,
			code: "import { query } from '../_generated/server';\nexport const q = query({});",
		},
		{
			name: 'a re-export of safe builders',
			filename,
			options,
			code: "export { internalQuery } from '../_generated/server';",
		},
	],
	invalid: [
		{
			name: 'a call, a multi-line call and an alias',
			filename,
			options,
			code: [
				"import { query, mutation as write } from '../_generated/server';",
				'export const list = query({ args: {}, handler: async () => null });',
				'export const save =',
				'\twrite({ args: {}, handler: async () => null });',
				'export const alias = query;',
			].join('\n'),
			errors: [raw('query'), raw('mutation'), raw('query')],
		},
		{
			name: 'a namespace member, with a .js specifier',
			filename,
			options,
			code: "import * as server from '../_generated/server.js';\nexport const run = server.action({ args: {}, handler: async () => null });",
			errors: [raw('action')],
		},
		{
			name: 'the generic originals from convex/server',
			filename,
			options,
			code: "import { queryGeneric } from 'convex/server';\nexport const list = queryGeneric({ args: {}, handler: async () => null });",
			errors: [raw('queryGeneric')],
		},
		{
			name: 'an import nothing uses yet',
			filename,
			options,
			code: "import { action } from '../_generated/server';",
			errors: [raw('action')],
		},
		{
			name: 're-exports',
			filename,
			options,
			code: "export { query as q } from '../_generated/server';\nexport * from 'convex/server';",
			errors: [raw('query'), raw('\\*')],
		},
	],
});
