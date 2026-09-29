/**
 * Self-test for the builder derivation the Convex definition gates share
 * (`apps/api/scripts/lib/convex-builders.sh`).
 *
 * Five gates (check-permissions, check-query-authz, check-session-threading,
 * check-token-redaction, check-errors) used to type their builder lists by
 * hand, and the lists drifted: check-errors never saw the 111 postbox
 * functions. They now read one list derived from source, so what has to hold
 * is that the derivation sees every builder:
 *
 *   * against the REAL tree, every value export of lib/authedFunctions.ts
 *     except featureGated/featureGatedAny is classified, the static base table
 *     is pinned, and every featureGated(Any) composition under convex/ is
 *     classified with its base's kind and floor;
 *   * in throwaway trees, a NEW composition is picked up by the gates without
 *     anyone editing a regex, and a builder the table cannot classify fails the
 *     gates instead of shrinking their subject set.
 */

import { execFile } from 'node:child_process';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	API_ROOT,
	AUTHED_FUNCTIONS,
	COMPOSITION,
	apiTree,
	convexSourceFiles,
	removeTrees,
	runGate,
} from './convexGates.testlib';

const run = promisify(execFile);

interface Builder {
	readonly kind: string;
	readonly floor: string;
}

/** Parse the helper's `name<TAB>kind<TAB>floor` rows. */
function parseTable(stdout: string): Map<string, Builder> {
	const table = new Map<string, Builder>();
	for (const line of stdout.split('\n').filter((row) => row.length > 0)) {
		const [name, kind, floor] = line.split('\t');
		table.set(name, { kind, floor });
	}
	return table;
}

// The floor each base builder enforces, read off lib/authedFunctions.ts. A
// change here is a change to what every gate scans: review the gates too.
const BASE_BUILDERS: Record<string, Builder> = {
	authedQuery: { kind: 'query', floor: 'member' },
	authedMutation: { kind: 'mutation', floor: 'member' },
	authedAction: { kind: 'action', floor: 'member' },
	authedIdentityMutation: { kind: 'mutation', floor: 'identity' },
	adminQuery: { kind: 'query', floor: 'role' },
	adminMutation: { kind: 'mutation', floor: 'role' },
	ownerMutation: { kind: 'mutation', floor: 'role' },
	platformAdminQuery: { kind: 'query', floor: 'role' },
	platformAdminMutation: { kind: 'mutation', floor: 'role' },
	platformSuperadminMutation: { kind: 'mutation', floor: 'role' },
	publicQuery: { kind: 'query', floor: 'public' },
	publicMutation: { kind: 'mutation', floor: 'public' },
	publicAction: { kind: 'action', floor: 'public' },
};

describe('convex builder derivation against the real tree', () => {
	let table: Map<string, Builder>;

	beforeAll(async () => {
		const { stdout } = await run('bash', ['scripts/lib/convex-builders.sh'], { cwd: API_ROOT });
		table = parseTable(stdout);
	});

	it('classifies every value export of lib/authedFunctions.ts', async () => {
		const source = await readFile(join(API_ROOT, AUTHED_FUNCTIONS), 'utf8');
		const exported = [...source.matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm)]
			.map((match) => match[1])
			.filter((name) => name !== 'featureGated' && name !== 'featureGatedAny');

		expect(exported.length).toBeGreaterThan(0);
		for (const name of exported) {
			expect(table.get(name), `${name} is not classified`).toBeDefined();
		}
	});

	it('pins the base builder table', () => {
		const bases = Object.fromEntries(
			[...table].filter(([name]) => name in BASE_BUILDERS).map(([name, row]) => [name, row])
		);
		expect(bases).toEqual(BASE_BUILDERS);
	});

	it('classifies every featureGated(Any) composition with its base floor', async () => {
		const seen: string[] = [];
		for (const path of await convexSourceFiles()) {
			if (path === AUTHED_FUNCTIONS) continue;
			const lines = (await readFile(join(API_ROOT, path), 'utf8')).split('\n');
			for (const [index, line] of lines.entries()) {
				if (!/featureGated(?:Any)?\(/.test(line) || /^\s*(?:\/\/|\*)/.test(line)) continue;
				const match = COMPOSITION.exec(line);
				expect(
					match,
					`${path}:${index + 1} composes a builder the helper cannot parse`
				).not.toBeNull();
				const [, name, base] = match as RegExpExecArray;
				expect(table.get(name), `${path}:${index + 1} ${name}`).toEqual(table.get(base));
				seen.push(name);
			}
		}

		// The three families in use today; a new one only adds to this.
		expect(seen).toEqual(
			expect.arrayContaining([
				'chatQuery',
				'chatMutation',
				'assistantQuery',
				'assistantMutation',
				'postboxQuery',
				'postboxMutation',
			])
		);
		expect(new Set(table.keys())).toEqual(new Set([...Object.keys(BASE_BUILDERS), ...seen]));
	});
});

describe('the gates pick up builders from source', () => {
	const roots: string[] = [];

	afterAll(() => removeTrees(roots));

	const ungatedWrite = [
		"const fooMutation = featureGated(authedMutation, 'foo');",
		'',
		'export const rename = fooMutation({',
		'\targs: {},',
		'\thandler: async (ctx, args) => {',
		'\t\tawait ctx.db.patch(args.id, { name: args.name });',
		'\t},',
		'});',
		'',
	].join('\n');

	it('check-permissions fails a new featureGated(authedMutation) write with no gate', async () => {
		const root = await apiTree({ 'convex/foo/rename.ts': ungatedWrite }, roots);
		const result = await runGate(root, 'check-permissions.sh');

		expect(result.code).toBe(1);
		expect(result.output).toContain('convex/foo/rename.ts:3:rename');
	});

	it('check-permissions passes the same write once it makes a decision', async () => {
		const gated = ungatedWrite.replace(
			'\t\tawait ctx.db.patch',
			"\t\trequirePermission(hasPermission(session.role, 'foo:write'));\n\t\tawait ctx.db.patch"
		);
		const root = await apiTree({ 'convex/foo/rename.ts': gated }, roots);

		expect((await runGate(root, 'check-permissions.sh')).code).toBe(0);
	});

	it('check-errors fails a bare throw inside a postboxMutation handler', async () => {
		const root = await apiTree(
			{
				'convex/mail/folders.ts': [
					'export const renameFolder = postboxMutation({',
					'\targs: {},',
					'\thandler: async (ctx, args) => {',
					"\t\tif (!args.name) throw new Error('A folder name is required');",
					'\t},',
					'});',
					'',
				].join('\n'),
			},
			roots
		);
		const result = await runGate(root, 'check-errors.sh');

		expect(result.code).toBe(1);
		expect(result.output).toContain('convex/mail/folders.ts:4:');
	});

	it.each(['check-permissions.sh', 'check-errors.sh'])(
		'%s fails loudly on a builder export it cannot classify',
		async (gate) => {
			const root = await apiTree({}, roots);
			const source = join(root, 'apps/api', AUTHED_FUNCTIONS);
			await appendFile(source, '\nexport const staffMutation = adminMutation;\n');
			const result = await runGate(root, gate);

			expect(result.code).not.toBe(0);
			expect(result.output).toContain('staffMutation is not classified');
		}
	);

	it.each([
		['check-query-authz.sh', ['--generate']],
		['check-session-threading.sh', ['--generate']],
		['check-token-redaction.sh', ['--generate', 'convex']],
	])('%s fails loudly when the builder source is missing', async (gate, args) => {
		const root = await apiTree({}, roots);
		await rm(join(root, 'apps/api', AUTHED_FUNCTIONS));
		const result = await runGate(root, gate, args);

		expect(result.code).not.toBe(0);
		expect(result.output).toContain('authedFunctions.ts not found');
	});
});
