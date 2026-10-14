/**
 * The migration manifest (migrations/manifest.ts) against the migration
 * modules: every ledger migration is listed or retired, with the release its
 * module records, and dependencies come before their dependents.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_MANIFEST, RETIRED_MIGRATIONS } from '../manifest';

const MIGRATIONS_DIR = join(__dirname, '..');

/** Each numbered migration module that writes the ledger, with its `INTRODUCED_IN`. */
function ledgerModules(): Map<string, string> {
	const modules = new Map<string, string>();
	for (const file of readdirSync(MIGRATIONS_DIR)) {
		if (!/^\d{4}_.+\.ts$/.test(file)) continue;
		const source = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
		if (!source.includes('beginMigrationRun(')) continue;
		const introducedIn = /const INTRODUCED_IN = '([^']+)'/.exec(source)?.[1];
		modules.set(file.replace(/\.ts$/, ''), introducedIn ?? '');
	}
	return modules;
}

describe('migration manifest', () => {
	const modules = ledgerModules();

	it('lists every ledger migration that is not retired', () => {
		const listed = new Set(MIGRATION_MANIFEST.map((entry) => entry.migration));
		const unlisted = [...modules.keys()].filter(
			(migration) => !listed.has(migration) && !RETIRED_MIGRATIONS.includes(migration)
		);
		expect(unlisted).toEqual([]);
	});

	it('lists only ledger migrations, each once', () => {
		const names = MIGRATION_MANIFEST.map((entry) => entry.migration);
		expect(new Set(names).size).toBe(names.length);
		for (const name of [...names, ...RETIRED_MIGRATIONS]) {
			expect(modules.has(name), name).toBe(true);
		}
	});

	it("records the release each module's ledger rows carry", () => {
		for (const entry of MIGRATION_MANIFEST) {
			expect(entry.introducedIn, entry.migration).toBe(modules.get(entry.migration));
		}
	});

	it('lists every dependency before the migration that waits for it', () => {
		const seen = new Set<string>();
		for (const entry of MIGRATION_MANIFEST) {
			for (const dependency of entry.dependsOn) {
				expect(seen.has(dependency), `${entry.migration} → ${dependency}`).toBe(true);
			}
			seen.add(entry.migration);
		}
	});
});
