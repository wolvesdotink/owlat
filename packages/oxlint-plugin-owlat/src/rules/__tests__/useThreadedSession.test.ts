import { join } from 'node:path';
import rule from '../useThreadedSession.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';
import { REPOSITORY_ROOT } from '../../__tests__/runOxlint.ts';

const filename = join(REPOSITORY_ROOT, 'apps/api/convex/workspaces/renameFixture.ts');
const options = [
	{
		files: ['apps/api/convex/**'],
		ignore: ['apps/api/convex/lib/**'],
		kinds: ['query', 'mutation'],
		floors: ['member', 'role'],
		helpers: ['getMutationContext', 'requireOrgPermission', 'requireAdminContext'],
	},
];
const reResolves = (name: string, builder: string, helper: string) => ({
	message: new RegExp(`^\`${name}\` \\(${builder}\\) calls ${helper}\\(\\)`),
});

const IMPORTS = [
	"import { authedMutation, authedAction, adminQuery, publicQuery, authedIdentityMutation } from '../lib/authedFunctions';",
	"import { postboxQuery } from '../mail/_helpers';",
	"import { internalMutation } from '../_generated/server';",
	"import { requireOrgPermission as gate, getMutationContext } from '../lib/sessionOrganization';",
	'',
].join('\n');

const define = (builder: string, body: string, above = '', name = 'rename') =>
	`${IMPORTS}${above}export const ${name} = ${builder}({\n\targs: {},\n\thandler: async (ctx, args) => {\n\t\t${body}\n\t\treturn null;\n\t},\n});\n`;

const RESOLVES = 'const { userId } = await getMutationContext(ctx);';

ruleTester.run('owlat/use-threaded-session', rule, {
	valid: [
		{
			name: 'the threaded session',
			filename,
			options,
			code: define(
				'authedMutation',
				"requirePermission(hasPermission(session.role, 'org:manage'));"
			).replace('async (ctx, args)', 'async (ctx, args, session)'),
		},
		...['internalMutation', 'publicQuery', 'authedIdentityMutation', 'authedAction'].map(
			(builder) => ({
				name: `${builder} resolves its own session by design`,
				filename,
				options,
				code: define(builder, RESOLVES),
			})
		),
		{
			name: 'an opt-out inside the definition',
			filename,
			options,
			code: define('authedMutation', `// session: reads a second org on purpose\n\t\t${RESOLVES}`),
		},
		{
			name: 'an opt-out directly above the export',
			filename,
			options,
			code: define(
				'authedMutation',
				RESOLVES,
				'// Some context.\n// session: switches the active org first\n'
			),
		},
		{
			name: 'a helper named in a comment or a string',
			filename,
			options,
			code: define(
				'authedMutation',
				"// requireOrgPermission(ctx, 'x') already ran in the floor\n\t\tconst note = 'getMutationContext(ctx)';"
			),
		},
		{
			name: 'a method that shares a helper name',
			filename,
			options,
			code: define('authedMutation', 'await guards.getMutationContext(ctx);'),
		},
		{
			name: 'a shared guard at module scope',
			filename,
			options,
			code: `${IMPORTS}async function guard(ctx: unknown) { return getMutationContext(ctx); }\nexport const rename = authedMutation({ args: {}, handler: async (ctx) => guard(ctx) });`,
		},
		{
			name: 'files under convex/lib',
			filename: join(REPOSITORY_ROOT, 'apps/api/convex/lib/fixture.ts'),
			options,
			code: define('authedMutation', RESOLVES),
		},
		{
			name: 'a file that calls no helper',
			filename,
			options,
			code: define('authedMutation', 'return 1;'),
		},
	],
	invalid: [
		{
			name: 'a member-floor mutation that re-resolves the session',
			filename,
			options,
			code: define('authedMutation', RESOLVES),
			errors: [reResolves('rename', 'authedMutation', 'getMutationContext')],
		},
		{
			name: 'a role-floor query through an aliased helper, reported once',
			filename,
			options,
			code: define(
				'adminQuery',
				"await gate(ctx, 'organization:manage');\n\t\tawait getMutationContext(ctx);"
			),
			errors: [reResolves('rename', 'adminQuery', 'requireOrgPermission')],
		},
		{
			name: 'a composed builder, formatted across lines',
			filename,
			options,
			code: `${IMPORTS}export const list =\n\tpostboxQuery({\n\t\targs: {},\n\t\thandler: async (ctx) => {\n\t\t\tawait getMutationContext(ctx);\n\t\t},\n\t});\n`,
			errors: [reResolves('list', 'postboxQuery', 'getMutationContext')],
		},
		{
			name: 'an opt-out separated by a blank line does not apply',
			filename,
			options,
			code: define('authedMutation', RESOLVES, '// session: belongs to something else\n\n'),
			errors: [reResolves('rename', 'authedMutation', 'getMutationContext')],
		},
	],
});
