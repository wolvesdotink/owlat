/**
 * A workspace `lint` task is cached by turbo, locally and in CI's remote cache,
 * and by default turbo hashes only the files inside the package directory. A
 * lint script that reads a file outside its package therefore replays a stale
 * result when only that outside file changes. #1219 removed the last web
 * caller of an api query; `@owlat/api#lint` (check-entry-wiring.ts) would have
 * failed, but its hash had not moved, CI replayed a green run and main broke.
 *
 * turbo.json gives the affected lint tasks explicit `inputs`, and every lint
 * task a transit dependency for the workspace packages oxlint follows imports
 * into. These cases read the real `turbo run --dry=json` file lists, so they
 * fail when an override is dropped or narrowed, when a glob stops matching, or
 * when a lint shell script starts reading a new outside path without the
 * override following it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Generated output, as every lint scanner that walks a directory outside its
 * package defines it and as turbo.json excludes it from the root-level globs
 * (which, unlike the default inputs, do not honour .gitignore): node_modules
 * and .nuxt anywhere, the output directories only at a package root. A nested
 * source directory that shares an output name (components/build/) is source.
 */
const GENERATED_ANYWHERE = new Set(['node_modules', '.nuxt']);
const PACKAGE_OUTPUT = new Set(['build', 'dist', '.output', 'coverage', '.turbo']);

const isPackageRoot = (directory: string): boolean =>
	existsSync(join(REPOSITORY_ROOT, directory, 'package.json'));

/** Is the repo-relative `file` inside generated output? */
function isGenerated(file: string): boolean {
	const parts = file.split('/');
	return parts
		.slice(0, -1)
		.some(
			(part, index) =>
				GENERATED_ANYWHERE.has(part) ||
				(PACKAGE_OUTPUT.has(part) && isPackageRoot(parts.slice(0, index).join('/') || '.'))
		);
}

interface DryRunTask {
	readonly taskId: string;
	readonly task: string;
	readonly package: string;
	readonly directory: string;
	readonly dependencies: readonly string[];
	readonly inputs: Readonly<Record<string, string>>;
}

interface LintTask {
	readonly directory: string;
	readonly dependencies: readonly string[];
	/** Repo-relative input files. */
	readonly files: ReadonlySet<string>;
}

let lintTasks: Map<string, LintTask>;

beforeAll(() => {
	const dryRun = JSON.parse(
		execFileSync(
			join(REPOSITORY_ROOT, 'node_modules/.bin/turbo'),
			['run', 'lint', '--dry=json', '--filter=!@owlat/desktop'],
			{ cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
		)
	) as { tasks: DryRunTask[] };
	lintTasks = new Map(
		dryRun.tasks
			.filter((task) => task.task === 'lint')
			.map((task) => [
				task.package,
				{
					directory: task.directory,
					dependencies: task.dependencies,
					files: new Set(
						Object.keys(task.inputs).map((file) => normalize(join(task.directory, file)))
					),
				},
			])
	);
}, 120_000);

function lintTask(packageName: string): LintTask {
	const task = lintTasks.get(packageName);
	if (task === undefined) throw new Error(`${packageName}#lint is missing from the dry run`);
	return task;
}

/** Every file under `directory` (repo-relative) outside generated output. */
function walk(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(join(REPOSITORY_ROOT, directory), { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			const generated =
				GENERATED_ANYWHERE.has(entry.name) ||
				(PACKAGE_OUTPUT.has(entry.name) && isPackageRoot(directory));
			if (!generated) found.push(...walk(path));
		} else if (entry.isFile()) {
			found.push(path);
		}
	}
	return found;
}

function missingFrom(files: ReadonlySet<string>, read: readonly string[]): string[] {
	return read.filter((file) => !files.has(file));
}

/**
 * The shell word starting at `start`, with its quotes removed: quoting and
 * nested `$(…)` are followed, so `"$(dirname "$0")/lib/x.sh"` is one word.
 */
function shellWord(text: string, start: number): string {
	let word = '';
	let quote: string | undefined;
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		const char = text[index]!;
		if (depth > 0) {
			word += char;
			if (char === '(') depth++;
			else if (char === ')') depth--;
		} else if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
		} else if (char === '$' && text[index + 1] === '(') {
			word += '$(';
			depth = 1;
			index++;
		} else if (quote === '"') {
			if (char === '"') quote = undefined;
			else word += char;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (/[\s;&|)]/.test(char)) {
			break;
		} else {
			word += char;
		}
	}
	return word;
}

/** The argument of every `source x` / `. x` in command position. */
function sourcedArguments(source: string): string[] {
	return [...source.matchAll(/(?:^|;|&&|\|\||\bthen|\bdo)[ \t]*(?:source|\.)[ \t]+/gm)].map(
		(match) => shellWord(source, match.index + match[0].length)
	);
}

const SCRIPT_DIRECTORY = /^\$\(dirname "\$(?:0|\{BASH_SOURCE\[0\]\})"\)\//;
const REPOSITORY_ROOT_VARIABLE = /^\$\{?(?:repo_root|ROOT)\}?\//;

/**
 * A sourced path as the scripts write it, repo-relative: relative to the
 * script's own directory, to the repo root, or else to the package (every lint
 * script runs there). Undefined when it depends on any other variable.
 */
function resolveSourced(argument: string, script: string, directory: string): string | undefined {
	const resolved = SCRIPT_DIRECTORY.test(argument)
		? join(dirname(script), argument.replace(SCRIPT_DIRECTORY, ''))
		: REPOSITORY_ROOT_VARIABLE.test(argument)
			? argument.replace(REPOSITORY_ROOT_VARIABLE, '')
			: join(directory, argument);
	return resolved.includes('$') ? undefined : normalize(resolved);
}

describe('sourced helper parsing', () => {
	const script = 'apps/api/scripts/check-x.sh';
	const resolve = (text: string): (string | undefined)[] =>
		sourcedArguments(text).map((argument) => resolveSourced(argument, script, 'apps/api'));

	it('reads a quoted path with a nested command substitution as one word', () => {
		expect(resolve('source "$(dirname "$0")/lib/convex-builders.sh"\n')).toEqual([
			'apps/api/scripts/lib/convex-builders.sh',
		]);
		expect(resolve('. "$(dirname "${BASH_SOURCE[0]}")/lib/a.sh"\n')).toEqual([
			'apps/api/scripts/lib/a.sh',
		]);
	});

	it('reads the unquoted form', () => {
		expect(resolve('source $(dirname "$0")/lib/convex-builders.sh\n')).toEqual([
			'apps/api/scripts/lib/convex-builders.sh',
		]);
	});

	it('reads the literal `.` form, relative to the package or the repo root', () => {
		expect(resolve('. scripts/lib/convex-builders.sh\n')).toEqual([
			'apps/api/scripts/lib/convex-builders.sh',
		]);
		expect(resolve('if true; then . "$repo_root/scripts/ratchet.sh"; fi\n')).toEqual([
			'scripts/ratchet.sh',
		]);
	});

	it('ignores a `.` that is an argument, and flags a path it cannot resolve', () => {
		expect(resolve('find . -name \'*.sh\'\ncd "$(dirname "$0")/.."\n')).toEqual([]);
		expect(resolve('source "$HOME/lib.sh"\n')).toEqual([undefined]);
	});
});

describe('workspace lint task inputs', () => {
	it('hash every client file check-entry-wiring.ts reads', async () => {
		// The check's own walk, so a file it reads but turbo does not hash fails.
		// Imported by computed path: scripts/ never imports workspace sources by
		// a relative specifier (lint:imports).
		const sourceGraph = (await import(
			join(REPOSITORY_ROOT, 'apps/api/scripts/lib/sourceGraph.ts')
		)) as {
			productionModules: (root: string, options: { extensions: string[] }) => string[];
		};
		const convexRoot = join(REPOSITORY_ROOT, 'apps/api/convex');
		const clients = ['apps', 'packages']
			.flatMap((workspace) =>
				sourceGraph.productionModules(join(REPOSITORY_ROOT, workspace), {
					extensions: ['.ts', '.vue'],
				})
			)
			.filter((file) => !file.startsWith(`${convexRoot}/`))
			.map((file) => relative(REPOSITORY_ROOT, file));

		expect(clients).toContain('apps/web/app/app.vue');
		expect(clients).toContain('apps/mail-sync/src/convex.ts');
		expect(missingFrom(lintTask('@owlat/api').files, clients)).toEqual([]);
	});

	it('hash the workflow, docs and ratchet runner the api checks read', () => {
		expect(
			missingFrom(lintTask('@owlat/api').files, [
				'.github/workflows/test.yml',
				'apps/docs/content/en/3.developer/8.environment-variables.md',
				'apps/docs/content/en/3.developer/6.email-system.md',
				'scripts/ratchet.sh',
				'packages/shared/package.json',
			])
		).toEqual([]);
	});

	it('hash both env key lists for the setup-cli sync check', () => {
		expect(
			missingFrom(lintTask('@owlat/setup-cli').files, [
				'apps/api/convex/lib/env.ts',
				'packages/shared/src/convexRuntimeEnv.ts',
			])
		).toEqual([]);
	});

	it('depend on the transit chain, so a dependency package edit reaches oxlint', () => {
		// import/no-cycle follows imports into dependency packages; the transit
		// task folds their file hashes into the lint hash.
		for (const [packageName, task] of lintTasks) {
			expect(task.dependencies, packageName).toContain(`${packageName}#transit`);
		}
	});

	it('leave generated trees out, so a build, nuxt prepare or turbo log cannot move a hash', () => {
		for (const [packageName, { files }] of lintTasks) {
			expect([...files].filter(isGenerated), packageName).toEqual([]);
		}
	});

	it('hash every file under every outside path a lint shell script names', () => {
		// The shell scripts of each lint chain, plus the helpers they source.
		// A path literal that escapes the package (`../…`) or starts at the repo
		// root (`$repo_root/…`, `$ROOT/…`) is an outside read. A file literal must
		// be an input; a directory literal must contribute every file under it
		// outside generated output, a superset of what any scanner reads.
		const missing: string[] = [];
		const unresolved: string[] = [];
		for (const [packageName, { directory, files }] of lintTasks) {
			const manifest = JSON.parse(
				readFileSync(join(REPOSITORY_ROOT, directory, 'package.json'), 'utf8')
			) as { scripts?: Record<string, string> };
			const queue = [
				...(manifest.scripts?.['lint'] ?? '').matchAll(/\bbash (scripts\/[\w./-]+\.sh)/g),
			].map((match) => join(directory, match[1]!));
			const seen = new Set<string>();
			while (queue.length > 0) {
				const script = queue.shift()!;
				if (seen.has(script)) continue;
				seen.add(script);
				const source = readFileSync(join(REPOSITORY_ROOT, script), 'utf8')
					.split('\n')
					.filter((line) => !/^\s*#/.test(line))
					.join('\n');
				for (const sourced of sourcedArguments(source)) {
					const path = resolveSourced(sourced, script, directory);
					if (path === undefined || !existsSync(join(REPOSITORY_ROOT, path))) {
						unresolved.push(`${packageName}: ${script} sources ${sourced}`);
					} else {
						queue.push(path);
					}
				}
				// `$(dirname "$0")/…` is relative to the script; a bare `../…` to the
				// package, where every lint script runs.
				const scriptRelative = new RegExp(`${SCRIPT_DIRECTORY.source.slice(1)}([\\w.@/-]+)`, 'g');
				const literals = [
					...[...source.matchAll(scriptRelative)].map((match) =>
						normalize(join(dirname(script), match[1]!))
					),
					...[
						...source.replace(scriptRelative, '').matchAll(/(?<![\w$])((?:\.\.\/)+[\w.@/-]+)/g),
					].map((match) => normalize(join(directory, match[1]!))),
					...[...source.matchAll(/\$\{?(?:repo_root|ROOT)\}?\/([\w.@/-]+)/g)].map((match) =>
						normalize(match[1]!)
					),
				];
				for (const literal of new Set(literals)) {
					// Inside the package (default inputs), or the package, the repo root
					// or a path above it as a whole: those are `cd` targets, not reads.
					if (
						literal === directory ||
						literal.startsWith(`${directory}/`) ||
						literal === '.' ||
						literal.startsWith('..')
					) {
						continue;
					}
					if (!existsSync(join(REPOSITORY_ROOT, literal))) continue;
					const read = statSync(join(REPOSITORY_ROOT, literal)).isDirectory()
						? walk(literal)
						: [literal];
					for (const file of missingFrom(files, read)) {
						missing.push(`${packageName}: ${script} reads ${file}`);
					}
				}
			}
		}
		expect(unresolved).toEqual([]);
		expect(missing).toEqual([]);
	});
});
