import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ValidatorJSON } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { writeSnapshot } from './snapshot';

/**
 * Rewrites `previousRelease.json` from the schema of a release tag. Skipped in
 * normal runs; `bun run --cwd apps/api schema-compat:refresh` sets the switch.
 * The tag defaults to the newest `vX.Y.Z` reachable from HEAD, so running it on
 * the release commit right after `release:cut` snapshots that release. Set
 * OWLAT_SCHEMA_COMPAT_REF to snapshot another ref, and
 * OWLAT_SCHEMA_COMPAT_RELEASE to record it under a release name other than the
 * ref (`release:cut` snapshots HEAD before the tag exists, as the new release).
 *
 * The tag's `convex/` tree is extracted next to this package so its imports of
 * `convex/*` and the `@owlat/*` source aliases resolve. Those aliases point at
 * the working tree's packages, not the tag's, which only matters if a schema
 * builds a validator from a package constant that changed since the tag.
 */

const REFRESH_SWITCH = 'OWLAT_SCHEMA_COMPAT_REFRESH';
const apiRoot = resolve(import.meta.dirname, '..', '..', '..');

function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: apiRoot, encoding: 'utf8' }).trim();
}

describe.skipIf(process.env[REFRESH_SWITCH] !== '1')('schema-compat fixture refresh', () => {
	it('snapshots the release table validators', async () => {
		const ref =
			process.env['OWLAT_SCHEMA_COMPAT_REF'] ||
			git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*');
		const release = process.env['OWLAT_SCHEMA_COMPAT_RELEASE'] || ref;
		expect(release).toMatch(/^v\d+\.\d+\.\d+$/);
		const commit = git('rev-parse', `${ref}^{commit}`);
		const convexRoot = join(apiRoot, '.schema-compat', ref, 'convex');
		rmSync(convexRoot, { recursive: true, force: true });
		mkdirSync(convexRoot, { recursive: true });
		try {
			// From a subdirectory `git archive` only emits that directory's part of
			// the tree, so it runs at the repository root.
			const archive = execFileSync('git', ['archive', '--format=tar', `${ref}:apps/api/convex`], {
				cwd: git('rev-parse', '--show-toplevel'),
				maxBuffer: 512 * 1024 * 1024,
			});
			execFileSync('tar', ['-x', '-f', '-', '-C', convexRoot], { input: archive });

			const schemaModule = (await import(join(convexRoot, 'schema.ts'))) as {
				default: { tables: Record<string, { validator: { json: ValidatorJSON } }> };
			};
			const tables: Record<string, ValidatorJSON> = {};
			for (const [name, table] of Object.entries(schemaModule.default.tables)) {
				tables[name] = table.validator.json;
			}
			expect(Object.keys(tables).length).toBeGreaterThan(0);
			writeSnapshot({ release, commit, tables });
		} finally {
			rmSync(join(apiRoot, '.schema-compat'), { recursive: true, force: true });
		}
	}, 120_000);
});
