/**
 * A workspace `lint` task is cached by turbo, locally and in CI's remote cache,
 * and by default turbo hashes only the files inside the package directory. A
 * lint script that reads a file outside its package therefore replays a stale
 * result when only that outside file changes. #1219 removed the last web
 * caller of an api query; `@owlat/api#lint` (check-entry-wiring.ts) would have
 * failed, but its hash had not moved, CI replayed a green run and main broke.
 *
 * turbo.json gives the affected lint tasks explicit `inputs`. These cases read
 * the real `turbo run --dry=json` file lists, so they fail when an override is
 * dropped, when a glob stops matching, or when a lint script starts naming a
 * new outside path in a shell script without the override following it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface DryRunTask {
	readonly package: string;
	readonly directory: string;
	readonly inputs: Readonly<Record<string, string>>;
}

/** Repo-relative input files of each workspace lint task, keyed by package name. */
let lintInputs: Map<string, { directory: string; files: Set<string> }>;

beforeAll(() => {
	const dryRun = JSON.parse(
		execFileSync(
			join(REPOSITORY_ROOT, 'node_modules/.bin/turbo'),
			['run', 'lint', '--dry=json', '--filter=!@owlat/desktop'],
			{ cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
		)
	) as { tasks: DryRunTask[] };
	lintInputs = new Map(
		dryRun.tasks.map((task) => [
			task.package,
			{
				directory: task.directory,
				files: new Set(
					Object.keys(task.inputs).map((file) => normalize(join(task.directory, file)))
				),
			},
		])
	);
}, 120_000);

function inputsOf(packageName: string): Set<string> {
	const task = lintInputs.get(packageName);
	if (task === undefined) throw new Error(`${packageName}#lint is missing from the dry run`);
	return task.files;
}

describe('workspace lint task inputs', () => {
	it('hash every client of the api for the entry-wiring check, not only apps/api', () => {
		const api = inputsOf('@owlat/api');
		for (const file of [
			'apps/web/app/app.vue',
			'apps/web/app/composables/auditLogFilterCatalog.ts',
			'apps/web/server/api/system/update.post.ts',
			'apps/mail-sync/src/convex.ts',
			'packages/shared/src/convexRuntimeEnv.ts',
			'packages/shared/package.json',
		]) {
			expect(api, file).toContain(file);
		}
	});

	it('hash the workflow, docs and ratchet runner the api checks read', () => {
		const api = inputsOf('@owlat/api');
		for (const file of [
			'.github/workflows/test.yml',
			'apps/docs/content/en/3.developer/8.environment-variables.md',
			'apps/docs/content/en/3.developer/6.email-system.md',
			'scripts/ratchet.sh',
		]) {
			expect(api, file).toContain(file);
		}
	});

	it('hash the UI layer and ratchet runner for the web checks', () => {
		const web = inputsOf('@owlat/web');
		expect(web).toContain('packages/ui/assets/css/tokens.css');
		expect(web).toContain('scripts/ratchet.sh');
		expect([...web].some((file) => file.startsWith('packages/ui/components/'))).toBe(true);
	});

	it('hash both env key lists for the setup-cli sync check', () => {
		const setupCli = inputsOf('@owlat/setup-cli');
		expect(setupCli).toContain('apps/api/convex/lib/env.ts');
		expect(setupCli).toContain('packages/shared/src/convexRuntimeEnv.ts');
	});

	it('leave generated trees out, so a local build or nuxt prepare cannot move a hash', () => {
		// Root-level globs do not honour .gitignore; turbo.json excludes these by hand.
		const generated = /(^|\/)(node_modules|\.nuxt|\.output|dist|build|coverage)\//;
		for (const [packageName, { files }] of lintInputs) {
			expect(
				[...files].filter((file) => generated.test(file)),
				packageName
			).toEqual([]);
		}
	});

	it('hash every outside path a lint shell script names', () => {
		// A path literal that escapes the package (`../…`) or starts at the repo
		// root (`$repo_root/…`, `$ROOT/…`) in a shell script of a lint chain.
		// Directory literals must contribute at least one file; file literals
		// must be inputs themselves.
		const missing: string[] = [];
		for (const [packageName, { directory, files }] of lintInputs) {
			const manifest = JSON.parse(
				readFileSync(join(REPOSITORY_ROOT, directory, 'package.json'), 'utf8')
			) as {
				scripts?: Record<string, string>;
			};
			const chain = manifest.scripts?.['lint'] ?? '';
			for (const [, script] of chain.matchAll(/\bbash (scripts\/[\w./-]+\.sh)/g)) {
				const source = readFileSync(join(REPOSITORY_ROOT, directory, script!), 'utf8')
					.split('\n')
					.filter((line) => !/^\s*#/.test(line))
					.join('\n');
				const literals = [
					...[...source.matchAll(/(?<![\w$])((?:\.\.\/)+[\w.@/-]+)/g)].map((match) =>
						normalize(join(directory, match[1]!))
					),
					...[...source.matchAll(/\$\{?(?:repo_root|ROOT)\}?\/([\w.@/-]+)/g)].map((match) =>
						normalize(match[1]!)
					),
				];
				for (const literal of new Set(literals)) {
					// Inside the package (default inputs) or above the repo (a `cd` to the root).
					if (literal.startsWith(`${directory}/`) || literal.startsWith('..')) continue;
					const absolute = join(REPOSITORY_ROOT, literal);
					if (!existsSync(absolute)) continue;
					const covered = statSync(absolute).isDirectory()
						? [...files].some((file) => file.startsWith(`${literal}/`))
						: files.has(literal);
					if (!covered) missing.push(`${packageName}: ${script} reads ${literal}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
