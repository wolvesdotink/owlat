/**
 * The builder list the Convex rules use is the one apps/api/scripts/lib/
 * convex-builders.sh derives, read from the same inputs. These cases pin the
 * two derivations to the same table on the real tree and on edge-case trees,
 * and pin the failures that must stop a rule rather than shrink its scope.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../../__tests__/runOxlint.ts';
import {
	builderTable,
	convexApiRoot,
	deriveBuilderTable,
	rawBuilderKind,
} from '../convexBuilders.ts';

const API_ROOT = join(REPOSITORY_ROOT, 'apps/api');
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The shell derivation's rows for `apiRoot`, or its failure. */
const shellRows = (apiRoot: string) => {
	const run = spawnSync('bash', [join(apiRoot, 'scripts/lib/convex-builders.sh')], {
		cwd: apiRoot,
		encoding: 'utf8',
	});
	return {
		status: run.status,
		rows: run.stdout.split('\n').filter(Boolean).sort(),
		stderr: run.stderr,
	};
};

const tableRows = (apiRoot: string) =>
	[...deriveBuilderTable(apiRoot).values()]
		.map(({ name, kind, floor }) => `${name}\t${kind}\t${floor}`)
		.sort();

/** An apps/api tree with the real shell library and authedFunctions.ts plus `files`. */
const apiTree = (files: Record<string, string>, authedFunctions?: string): string => {
	const root = mkdtempSync(join(tmpdir(), 'owlat-builders-'));
	roots.push(root);
	mkdirSync(join(root, 'scripts/lib'), { recursive: true });
	copyFileSync(
		join(API_ROOT, 'scripts/lib/convex-builders.sh'),
		join(root, 'scripts/lib/convex-builders.sh')
	);
	const seeded = {
		'convex/lib/authedFunctions.ts':
			authedFunctions ?? readFileSync(join(API_ROOT, 'convex/lib/authedFunctions.ts'), 'utf8'),
		...files,
	};
	for (const [path, contents] of Object.entries(seeded)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
};

describe('the Convex builder derivation', () => {
	it('matches the shell derivation on the real tree', () => {
		const shell = shellRows(API_ROOT);
		expect(shell.status).toBe(0);
		expect(tableRows(API_ROOT)).toEqual(shell.rows);
	});

	it('matches it on wrapped, nested, file-local and excluded compositions', () => {
		const root = apiTree({
			'convex/mail/_helpers.ts': [
				"export const postboxQuery = featureGated(authedQuery, 'mail');",
				'export const postboxMutation = featureGated(',
				'\tauthedMutation,',
				"\t'mail'",
				');',
			].join('\n'),
			'convex/mail/admin.ts': "const inboxAdmin = featureGatedAny(postboxMutation, ['a']);\n",
			'convex/__tests__/fixture.ts': "export const testOnly = featureGated(authedQuery, 'x');\n",
			'convex/mail/thing.test.ts': "export const testFile = featureGated(authedQuery, 'x');\n",
			'convex/_generated/api.ts': "export const generated = featureGated(authedQuery, 'x');\n",
		});
		const shell = shellRows(root);
		expect(shell.status).toBe(0);
		expect(tableRows(root)).toEqual(shell.rows);
		expect(tableRows(root)).toContain('inboxAdmin\tmutation\tmember');
		expect(tableRows(root).some((row) => /^test|^generated/.test(row))).toBe(false);
	});

	it.each([
		[
			'an unclassified builder export',
			{},
			`${readFileSync(join(API_ROOT, 'convex/lib/authedFunctions.ts'), 'utf8')}\nexport const sneakyQuery = query;\n`,
			/sneakyQuery .*not classified/,
		],
		[
			'a classified builder that is no longer exported',
			{},
			readFileSync(join(API_ROOT, 'convex/lib/authedFunctions.ts'), 'utf8').replace(
				'export const publicAction =',
				'const publicAction ='
			),
			/publicAction.*no longer exports/,
		],
		[
			'a composition of an unknown builder',
			{ 'convex/x.ts': "export const xQuery = featureGated(mysteryQuery, 'x');\n" },
			undefined,
			/xQuery composes unknown builder mysteryQuery/,
		],
		[
			'one name composed from two bases',
			{
				'convex/a.ts': "export const dualQuery = featureGated(authedQuery, 'a');\n",
				'convex/b.ts': "export const dualQuery = featureGated(publicQuery, 'b');\n",
			},
			undefined,
			/dualQuery is composed from publicQuery here and from authedQuery/,
		],
	])('fails, like the shell derivation, on %s', (_name, files, authedFunctions, message) => {
		const root = apiTree(files, authedFunctions);
		expect(shellRows(root).status).toBe(1);
		expect(() => deriveBuilderTable(root)).toThrow(message);
		const table = builderTable(root);
		expect(table).toBeInstanceOf(Error);
		// Derived once per root: the second ask returns the same result.
		expect(builderTable(root)).toBe(table);
	});

	it('fails when the shell library loses its classification table', () => {
		const root = apiTree({});
		writeFileSync(join(root, 'scripts/lib/convex-builders.sh'), '#!/usr/bin/env bash\n');
		expect(() => deriveBuilderTable(root)).toThrow(/CONVEX_BASE_BUILDERS not found/);
		writeFileSync(
			join(root, 'scripts/lib/convex-builders.sh'),
			"CONVEX_BASE_BUILDERS='authedQuery query'\n"
		);
		expect(() => deriveBuilderTable(root)).toThrow(/unreadable CONVEX_BASE_BUILDERS row/);
	});

	it('finds the apps/api root of a file under convex/, and none elsewhere', () => {
		expect(convexApiRoot(join(API_ROOT, 'convex/mail/deep/x.ts'))).toBe(API_ROOT);
		expect(convexApiRoot('/nowhere/convex/x.ts')).toBeUndefined();
	});

	it('recognizes the raw builders by module', () => {
		expect(rawBuilderKind('./_generated/server', 'query')).toBe('query');
		expect(rawBuilderKind('../../_generated/server.js', 'action')).toBe('action');
		expect(rawBuilderKind('./_generated/server', 'internalQuery')).toBeUndefined();
		expect(rawBuilderKind('convex/server', 'mutationGeneric')).toBe('mutation');
		expect(rawBuilderKind('convex/server', 'internalMutationGeneric')).toBeUndefined();
		expect(rawBuilderKind('./helpers', 'query')).toBeUndefined();
	});
});
