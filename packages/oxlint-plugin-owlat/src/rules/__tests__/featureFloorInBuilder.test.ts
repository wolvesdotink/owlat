import { join } from 'node:path';
import rule from '../featureFloorInBuilder.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';
import { REPOSITORY_ROOT } from '../../__tests__/runOxlint.ts';

const convex = (path: string) => join(REPOSITORY_ROOT, 'apps/api/convex', path);
const options = [
	{
		files: ['apps/api/convex/**'],
		families: [
			{ flag: 'mail.external', files: ['apps/api/convex/mail/**'] },
			{ flag: 'campaigns', files: ['apps/api/convex/campaigns/**'] },
		],
		bareBuilders: {
			builders: ['authedQuery', 'authedMutation'],
			files: ['apps/api/convex/mail/**'],
		},
		allow: [{ reason: 'soft-auth read', sites: ['apps/api/convex/mail/fixtureStatus.ts:status'] }],
	},
];
const inline = (name: string, flag: string) => ({
	message: new RegExp(`^\`${name}\` asserts '${flag.replace('.', '\\.')}' by hand`),
});
const bare = (name: string, builder: string) => ({
	message: new RegExp(`^\`${name}\` is built with ${builder}`),
});
const stale = (name: string) => ({
	message: new RegExp(`^\`${name}\`: stale owlat/feature-floor-in-builder exemption`),
});

const IMPORTS = [
	"import { authedQuery, authedMutation as write, publicQuery, adminQuery } from '../lib/authedFunctions';",
	"import { postboxQuery } from './_helpers';",
	"import { assertFeatureEnabled as assertFlag } from '../lib/featureFlags';",
	'',
].join('\n');
const define = (builder: string, body = '', name = 'start') =>
	`${IMPORTS}export const ${name} = ${builder}({\n\targs: {},\n\thandler: async (ctx) => {\n\t\t${body}\n\t\treturn null;\n\t},\n});\n`;
const ASSERT = "await assertFeatureEnabled(ctx, 'mail.external');";

ruleTester.run('owlat/feature-floor-in-builder', rule, {
	valid: [
		{
			name: 'a handler on the gated builder',
			filename: convex('mail/drafts.ts'),
			options,
			code: define('postboxQuery'),
		},
		{
			name: 'another flag asserted inside the family',
			filename: convex('mail/handlingRules.ts'),
			options,
			code: define('adminQuery', "await assertFeatureEnabled(ctx, 'ai.autonomy');"),
		},
		{
			name: 'a sub-flag inside the parent flag folder',
			filename: convex('campaigns/archive.ts'),
			options,
			code: define('adminQuery', "await assertFeatureEnabled(ctx, 'campaigns.archive');"),
		},
		{
			name: 'the family flag outside the family',
			filename: convex('workspaces/settings.ts'),
			options,
			code: define('authedQuery', ASSERT),
		},
		{
			name: 'a commented-out assert and a computed flag',
			filename: convex('mail/sendingSwitch.ts'),
			options,
			code: define('postboxQuery', `// ${ASSERT}\n\t\tawait assertFeatureEnabled(ctx, flag);`),
		},
		{
			name: 'a bare builder outside the listed files',
			filename: convex('contacts/list.ts'),
			options,
			code: define('authedQuery'),
		},
		{
			name: 'a justified site listed under allow',
			filename: convex('mail/fixtureStatus.ts'),
			options,
			code: define('publicQuery', `// flag-inline: soft-auth read\n\t\t${ASSERT}`, 'status'),
		},
		{
			name: 'test files',
			filename: convex('mail/__tests__/drafts.test.ts'),
			options,
			code: define('authedQuery', ASSERT),
		},
		{
			name: 'a file in no family',
			filename: convex('analytics/stats.ts'),
			options,
			code: 'export const x = 1;',
		},
	],
	invalid: [
		{
			name: 'an inline family assert, aliased or not, named after its declaration',
			filename: convex('mail/mailboxMove.ts'),
			options,
			code: [
				define('publicQuery', ASSERT),
				'export async function requireExternal(ctx: unknown) {',
				'\tawait assertFlag(ctx, "mail.external");',
				'}',
				'const local = async (ctx: unknown) => {',
				'\tawait assertFeatureEnabled(ctx, `mail.external`);',
				'};',
				"await assertFeatureEnabled(ctx, 'mail.external');",
			].join('\n'),
			errors: [
				inline('start', 'mail.external'),
				inline('requireExternal', 'mail.external'),
				inline('local', 'mail.external'),
				inline('<module>', 'mail.external'),
			],
		},
		{
			name: 'an inline assert in another family folder',
			filename: convex('campaigns/campaigns.ts'),
			options,
			code: define('authedQuery', "await assertFeatureEnabled(ctx, 'campaigns');"),
			errors: [inline('start', 'campaigns')],
		},
		{
			name: 'bare org-member builders under mail/, aliased or not',
			filename: convex('mail/drafts.ts'),
			options,
			code: `${define('authedQuery')}export const save = write({ args: {}, handler: async () => null });\n`,
			errors: [bare('start', 'authedQuery'), bare('save', 'authedMutation')],
		},
		{
			name: 'an allow entry nothing reports any more',
			filename: convex('mail/fixtureStatus.ts'),
			options,
			code: define('postboxQuery', '', 'status'),
			errors: [stale('status')],
		},
	],
});
