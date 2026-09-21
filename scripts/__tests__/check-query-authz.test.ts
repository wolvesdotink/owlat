/**
 * Conformance for the query-side authorization ratchet
 * (`apps/api/scripts/check-query-authz.sh`).
 *
 * The gate only ever recognized `authedQuery` / `chatQuery` / `assistantQuery`,
 * while the reads that carry the most org data — postbox, team inbox, knowledge
 * — are `publicQuery` exports that soft-fail in the handler. Ninety-odd reads
 * were therefore outside the gate's sight entirely, and a new one that forgot
 * its membership check would have passed.
 *
 * The cases here run the REAL script's `--generate` half (the violation lister,
 * before the shared ratchet compares it to the baseline) against throwaway
 * `apps/api` trees, and pin each way a read can satisfy the rule: a recognized
 * gate call, a soft-fail predicate, an `// authz:` / `// all-members:` opt-out —
 * plus the cases that must still be reported.
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

const GATE = 'apps/api/scripts/check-query-authz.sh';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/** `file:name` pairs the gate reports for a throwaway tree holding `files`. */
async function violations(files: Record<string, string>): Promise<string[]> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-query-authz-gate-'));
	roots.push(root);

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

/** A read built with `builder` whose handler body is `body`. */
function read(builder: string, body: string, note = ''): string {
	return [
		note,
		`export const listThreads = ${builder}({`,
		'\targs: {},',
		'\thandler: async (ctx) => {',
		body,
		'\t\treturn [];',
		'\t},',
		'});',
		'',
	]
		.filter((line) => line !== '')
		.join('\n');
}

describe('convex query authorization ratchet', () => {
	it.each(['authedQuery', 'chatQuery', 'assistantQuery', 'publicQuery', 'publicAction'])(
		'reports a %s that makes no authorization decision',
		async (builder) => {
			expect(
				await violations({
					'convex/mail/queries.ts': read(builder, '\t\tawait ctx.db.query("x");'),
				})
			).toEqual(['convex/mail/queries.ts:listThreads']);
		}
	);

	it('says nothing about an internalQuery — server-only, no public surface', async () => {
		expect(await violations({ 'convex/mail/queries.ts': read('internalQuery', '') })).toEqual([]);
	});

	// The predicates a soft-failing read uses instead of throwing: each answers
	// "may this caller read this?", and its caller returns empty on `false`.
	it.each([
		'\t\tif (!(await isActiveOrgMember(ctx))) return [];',
		'\t\tif (!isSharedInboxReader(session)) return [];',
		'\t\tconst mailbox = await loadReadableMailbox(ctx, args.mailboxId);',
		'\t\tconst message = await loadReadableMessage(ctx, args.messageId);',
		'\t\tconst boxes = await loadAccessibleMailboxes(ctx, userId, orgId);',
		'\t\tawait requireMailboxAccess(ctx, args.mailboxId);',
	])('accepts the in-handler gate %j', async (gate) => {
		expect(await violations({ 'convex/mail/queries.ts': read('publicQuery', gate) })).toEqual([]);
	});

	it('does NOT accept the `// public:` note as an authorization decision', async () => {
		const note = '// public: soft-auth — returns empty for anonymous';
		expect(
			await violations({ 'convex/mail/queries.ts': read('publicQuery', '\t\tconst x = 1;', note) })
		).toEqual(['convex/mail/queries.ts:listThreads']);
	});

	it.each([
		'// authz: the gate lives in the internal query this runs',
		'// all-members: the folder list is member-visible by design',
	])('accepts the opt-out comment %j above the export', async (note) => {
		expect(
			await violations({ 'convex/mail/queries.ts': read('publicQuery', '\t\tconst x = 1;', note) })
		).toEqual([]);
	});

	it('accepts an opt-out comment inside the handler body', async () => {
		expect(
			await violations({
				'convex/mail/queries.ts': read('publicQuery', '\t\t// authz: enforced downstream'),
			})
		).toEqual([]);
	});

	it('does not carry an opt-out comment across an intervening statement', async () => {
		expect(
			await violations({
				'convex/mail/queries.ts': [
					'// authz: this one is fine',
					'export const listFolders = publicQuery({',
					'\targs: {},',
					'\thandler: async () => [],',
					'});',
					'',
					'export const listThreads = publicQuery({',
					'\targs: {},',
					'\thandler: async () => [],',
					'});',
					'',
				].join('\n'),
			})
		).toEqual(['convex/mail/queries.ts:listThreads']);
	});
});
