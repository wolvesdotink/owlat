/**
 * Conformance for the feature-floor ratchet
 * (`apps/api/scripts/check-feature-floors.sh`).
 *
 * The cases run the REAL script's `--generate` half against throwaway
 * `apps/api` trees and pin what it reports: an inline
 * `assertFeatureEnabled(ctx, '<flag>')` inside that flag's gated family (the
 * mail.external family and the transactional, campaigns, automations and forms
 * folders), and a bare `authedQuery` / `authedMutation` export under
 * `convex/mail/`. A handler
 * on the gated builder, another flag's assert, or a file outside the family is
 * not reported.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = promisify(execFile);

const GATE = 'apps/api/scripts/check-feature-floors.sh';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/** `file:name` pairs the gate reports for a throwaway tree holding `files`. */
async function violations(files: Record<string, string>): Promise<string[]> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-feature-floor-gate-'));
	roots.push(root);

	await mkdir(join(root, 'apps/api/convex/mail'), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, 'apps/api', path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'apps/api/scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));

	const { stdout } = await run('bash', [GATE, '--generate'], { cwd: root });
	return stdout.split('\n').filter((line) => line.length > 0);
}

/** A handler built with `builder` whose body is `body`. */
function handler(builder: string, body = ''): string {
	return [
		`export const start = ${builder}({`,
		'\targs: {},',
		'\thandler: async (ctx) => {',
		body,
		'\t\treturn null;',
		'\t},',
		'});',
		'',
	]
		.filter((line) => line !== '')
		.join('\n');
}

const INLINE_ASSERT = "\t\tawait assertFeatureEnabled(ctx, 'mail.external');";

describe('convex feature-floor ratchet', () => {
	it('reports an inline mail.external assert inside the mail family', async () => {
		expect(
			await violations({
				'convex/mail/mailboxMove.ts': handler('publicQuery', INLINE_ASSERT),
			})
		).toEqual(['convex/mail/mailboxMove.ts:start']);
	});

	it('reports a double-quoted assert inside a plain helper by its function name', async () => {
		expect(
			await violations({
				'convex/mail/external/accounts.ts': [
					'export async function requireExternal(ctx: QueryCtx) {',
					'\tawait assertFeatureEnabled(ctx, "mail.external");',
					'}',
					'',
				].join('\n'),
			})
		).toEqual(['convex/mail/external/accounts.ts:requireExternal']);
	});

	it.each([
		['transactional', 'convex/transactional/translations.ts'],
		['campaigns', 'convex/campaigns/campaigns.ts'],
		['automations', 'convex/automations/steps.ts'],
		['forms', 'convex/forms/endpoints.ts'],
	])('reports an inline %s assert inside its own folder', async (flag, path) => {
		expect(
			await violations({
				[path]: handler('authedMutation', `\t\tawait assertFeatureEnabled(ctx, '${flag}');`),
			})
		).toEqual([`${path}:start`]);
	});

	it('ignores a sub-flag asserted inside the parent flag folder', async () => {
		expect(
			await violations({
				'convex/campaigns/archiveQueries.ts': handler(
					'campaignsQuery',
					"\t\tawait assertFeatureEnabled(ctx, 'campaigns.archive');"
				),
			})
		).toEqual([]);
	});

	it.each(['authedQuery', 'authedMutation'])(
		'reports a bare %s export under convex/mail/',
		async (builder) => {
			expect(await violations({ 'convex/mail/drafts.ts': handler(builder) })).toEqual([
				'convex/mail/drafts.ts:start',
			]);
		}
	);

	it.each([
		'postboxQuery',
		'postboxMutation',
		'externalMailQuery',
		'externalMailMutation',
		'externalMailAdminMutation',
		'transactionalQuery',
		'campaignsMutation',
		'automationsQuery',
		'formsMutation',
		'adminQuery',
		'internalMutation',
	])('says nothing about a handler on %s', async (builder) => {
		expect(await violations({ 'convex/mail/drafts.ts': handler(builder) })).toEqual([]);
	});

	it('ignores another flag asserted inside the mail family', async () => {
		expect(
			await violations({
				'convex/mail/handlingRules.ts': handler(
					'adminQuery',
					"\t\tawait assertFeatureEnabled(ctx, 'ai.autonomy');"
				),
			})
		).toEqual([]);
	});

	it('ignores the family flag asserted outside the family, and commented-out asserts', async () => {
		expect(
			await violations({
				'convex/workspaces/settings.ts': handler('authedMutation', INLINE_ASSERT),
				'convex/mail/sendingSwitch.ts': handler(
					'externalMailMutation',
					"\t\t// await assertFeatureEnabled(ctx, 'mail.external');"
				),
			})
		).toEqual([]);
	});

	it('does not report a bare builder outside convex/mail/', async () => {
		expect(await violations({ 'convex/contacts/list.ts': handler('authedQuery') })).toEqual([]);
	});
});
