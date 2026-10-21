/**
 * Runs CI's fast checks for this branch's changes, then prints what CI still
 * runs on top.
 *
 *   bun run check:changed                  compare with the merge base with origin/main
 *   bun run check:changed <ref>            compare with the merge base with <ref>
 *   bun run check:changed -- --dry-run     print the plan without running it
 *
 * Committed, staged, unstaged and untracked files all count. In order:
 *
 *   1. the oxfmt format gate and oxlint on the changed files;
 *   2. the plugin smokes (the Convex bundle among them), only when the backend
 *      or the plugin packages are affected;
 *   3. `turbo lint` and `turbo typecheck` for the workspaces turbo reports as
 *      affected (through the package graph), plus any workspace whose task
 *      reads a changed file outside its own directory (turbo.json `inputs`),
 *      and the scripts/ typecheck when its inputs changed;
 *   4. the root `lint:*` gates whose inputs changed (scripts/ci/gates.ts, the
 *      list CI's lint job runs in full);
 *   5. per affected workspace, `vitest related` on the changed files; the API
 *      suite gets its changed and neighbouring test files instead, and a change
 *      `related` cannot follow (a deleted file, the workspace's test config or
 *      manifest, the lockfile, a root test config) runs the whole suite.
 *
 * Every step runs even after one fails; the exit status is non-zero if any
 * failed. TURBO_CONCURRENCY bounds the typecheck (default 4) and
 * VITEST_MAX_WORKERS each vitest run (default 4).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	GATE_GLOBAL_INPUTS,
	PLUGIN_SMOKES,
	ROOT_GATES,
	SCRIPTS_TYPECHECK_INPUTS,
	gateCommand,
} from './ci/gates';
import {
	coverageWorkspaces,
	expectedJobs,
	gateSelected,
	planTests,
	rootInputSelection,
	selectCiWork,
	type Change,
	type CiSelection,
	type DockerImage,
	type TestWorkspace,
	type TurboTaskConfig,
} from './ci/selection';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** CI's lint, typecheck and test entries all leave the desktop shell out. */
const EXCLUDED_WORKSPACES = new Set(['@owlat/desktop']);
/**
 * The API suite's import graph is the whole backend: its tests glob the Convex
 * modules, so `vitest related` on one backend file selects most of the suite
 * and runs out of memory. It gets the changed and neighbouring test files.
 */
const NO_RELATED = new Set(['@owlat/api']);
/** What the oxlint step and the warnings gate lint. */
const LINT_ROOTS = /^(apps|packages|scripts|examples)\//;
const LINTABLE = /\.([cm]?[jt]sx?|vue)$/;

export class CheckChangedError extends Error {}

export interface Step {
	name: string;
	command: string[];
	/** Repo-relative working directory; the root when absent. */
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export interface WorkspaceInfo {
	name: string;
	directory: string;
	scripts: Record<string, string>;
}

export interface PlanInput {
	mergeBase: string;
	changes: Change[];
	workspaces: WorkspaceInfo[];
	/** Workspaces `turbo ls --affected` reports, dependents included. */
	affected: Set<string>;
	turboTasks: Record<string, TurboTaskConfig>;
	images: DockerImage[];
	listDirectory: (directory: string) => string[];
	vitestBin: (directory: string) => string;
	env: Record<string, string | undefined>;
}

export interface Plan {
	steps: Step[];
	/** CI lint-job entries this plan does not run. */
	skipped: string[];
	/** Workspaces whose tests were narrowed to nothing, with why. */
	notes: string[];
	ci: CiSelection;
}

// ---- discovery --------------------------------------------------------------

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (run.error) throw run.error;
	return { status: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

export function resolveMergeBase(root: string, ref: string): string {
	if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0)
		throw new CheckChangedError(
			`check:changed: base ref '${ref}' not found. Run \`git fetch origin\` or pass a ref.`
		);
	const mergeBase = git(root, ['merge-base', 'HEAD', ref]);
	if (mergeBase.status !== 0)
		throw new CheckChangedError(`check:changed: HEAD has no merge base with '${ref}'.`);
	return mergeBase.stdout.trim();
}

/**
 * Every path that differs between the merge base and the working tree, plus
 * untracked files. NUL-delimited, so any file name survives; `--no-renames`
 * lists a rename as its old path (deleted) and its new path, as CI sees it.
 */
export function changedFiles(root: string, mergeBase: string): Change[] {
	const list = (args: string[]) => {
		const run = git(root, args);
		if (run.status !== 0)
			throw new CheckChangedError(`check:changed: git ${args[0]} failed: ${run.stderr.trim()}`);
		return run.stdout.split('\0').filter(Boolean);
	};
	const paths = new Set([
		...list(['diff', '--name-only', '-z', '--no-renames', mergeBase, '--']),
		...list(['ls-files', '-z', '--others', '--exclude-standard']),
	]);
	return [...paths].sort().map((path) => ({ path, deleted: !pathExists(join(root, path)) }));
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * turbo.json is JSONC: drop comments and trailing commas outside strings, so
 * `"$TURBO_ROOT$/apps/**\/*.ts"` keeps its `/*`.
 */
export function parseJsonc(text: string): unknown {
	let out = '';
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (char === '"') {
			const start = index;
			for (index++; index < text.length && text[index] !== '"'; index++)
				if (text[index] === '\\') index++;
			out += text.slice(start, index + 1);
		} else if (text.startsWith('//', index)) {
			while (index < text.length && text[index] !== '\n') index++;
			out += '\n';
		} else if (text.startsWith('/*', index)) {
			const end = text.indexOf('*/', index + 2);
			if (end < 0) throw new SyntaxError('Unterminated block comment');
			index = end + 1;
		} else out += char;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function turboJson(root: string, args: string[], env: Record<string, string | undefined>) {
	const run = spawnSync(join(root, 'node_modules/.bin/turbo'), args, {
		cwd: root,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	});
	if (run.error) throw run.error;
	if (run.status !== 0)
		throw new CheckChangedError(`check:changed: turbo ${args.join(' ')} failed:\n${run.stderr}`);
	return (JSON.parse(run.stdout) as { packages: { items: { name: string; path: string }[] } })
		.packages.items;
}

// ---- planning ---------------------------------------------------------------

export function buildPlan(input: PlanInput): Plan {
	const { changes, workspaces, affected } = input;
	const paths = changes.map((change) => change.path);
	const present = changes.filter((change) => !change.deleted).map((change) => change.path);
	const included = workspaces.filter((w) => !EXCLUDED_WORKSPACES.has(w.name));
	const names = included.map((w) => w.name);
	const selected = (task: string) => {
		const extra = new Set(rootInputSelection(input.turboTasks, task, paths, names));
		return included.filter((w) => w.scripts[task] && (affected.has(w.name) || extra.has(w.name)));
	};
	const gateOn = (gate: Parameters<typeof gateSelected>[0]) =>
		gateSelected(gate, paths, affected, GATE_GLOBAL_INPUTS);

	const steps: Step[] = [];
	const skipped: string[] = [];
	const format = ROOT_GATES.find((gate) => gate.name === 'format')!;
	if (gateOn(format))
		steps.push({
			name: 'format (oxfmt)',
			command: [...gateCommand(format)],
			env: { OXFMT_BASE: input.mergeBase, GITHUB_BASE_REF: undefined },
		});
	const lintable = present.filter((file) => LINT_ROOTS.test(file) && LINTABLE.test(file));
	if (lintable.length)
		steps.push({
			name: `oxlint (${lintable.length} files)`,
			command: ['node_modules/.bin/oxlint', '--config', 'oxlintrc.json', ...lintable],
		});

	for (const smoke of PLUGIN_SMOKES) {
		if (gateOn(smoke)) steps.push({ name: `smoke ${smoke.name}`, command: [...smoke.command] });
		else skipped.push(`smoke ${smoke.name}`);
	}

	const turboStep = (task: string, extra: string[]) => {
		const targets = selected(task);
		if (targets.length)
			steps.push({
				name: `${task} (${targets.length} workspaces)`,
				command: [
					'node_modules/.bin/turbo',
					'run',
					task,
					...extra,
					...targets.map((w) => `--filter=${w.name}`),
				],
			});
	};
	turboStep('lint', []);
	turboStep('typecheck', [`--concurrency=${input.env['TURBO_CONCURRENCY'] || '4'}`]);
	if (gateOn(SCRIPTS_TYPECHECK_INPUTS))
		steps.push({ name: 'typecheck scripts/', command: ['bun', 'run', 'typecheck:scripts'] });

	for (const gate of ROOT_GATES) {
		if (gate === format) continue;
		if (gateOn(gate)) steps.push({ name: `lint:${gate.name}`, command: [...gateCommand(gate)] });
		else skipped.push(`lint:${gate.name}`);
	}
	if (!gateOn(format)) skipped.push('lint:format');

	const workers = `--maxWorkers=${input.env['VITEST_MAX_WORKERS'] || '4'}`;
	const testWorkspaces: TestWorkspace[] = selected('test')
		.filter((w) => /^vitest\b/.test(w.scripts['test'] ?? ''))
		.map((w) => ({
			package: w.name,
			name: w.name.replace(/^@owlat\//, ''),
			directory: w.directory,
			related: !NO_RELATED.has(w.name),
		}));
	const notes: string[] = [];
	for (const test of planTests(testWorkspaces, changes, input.listDirectory)) {
		const { directory, package: name } = test.workspace;
		const vitest = input.vitestBin(directory);
		if (test.mode === 'full')
			steps.push({
				name: `test ${name} (full suite: ${test.reason})`,
				command: [vitest, 'run', '--passWithNoTests', workers],
				cwd: directory,
			});
		else if (test.mode === 'related' && test.files.length)
			steps.push({
				name: `test ${name} (related)`,
				command: [
					vitest,
					'related',
					'--run',
					'--passWithNoTests',
					workers,
					...test.files.map((file) => relative(directory, file)),
				],
				cwd: directory,
			});
		else if (test.files.length)
			steps.push({
				name: `test ${name} (${test.files.length} changed and neighbouring test files)`,
				command: [vitest, 'run', workers, ...test.files.map((file) => relative(directory, file))],
				cwd: directory,
			});
		else if (test.mode === 'related')
			// Only deletions elsewhere: `related` with no files would run the whole
			// suite, and the workspace typecheck already fails on a removed import.
			notes.push(`${name}: only deleted files changed; CI runs its full suite`);
		else notes.push(`${name}: no changed or neighbouring test files; CI runs its full suite`);
	}

	const coverage = coverageWorkspaces(
		workspaces
			.filter((w) => affected.has(w.name))
			.map((w) => ({
				task: 'test:coverage',
				package: w.name,
				directory: w.directory,
				command: w.scripts['test:coverage'],
			}))
	);
	const ci = selectCiWork({
		full: false,
		changed: paths,
		coverage,
		affected: [...affected],
		images: input.images,
	});
	return { steps, skipped, notes, ci };
}

/** The jobs CI runs for this change and what each covers beyond this run. */
export function ciAlsoRuns(plan: Plan): string[] {
	const { ci } = plan;
	const describe: Record<string, string> = {
		lint: plan.skipped.length
			? `every root gate and plugin smoke (not run here: ${plan.skipped.join(', ')})`
			: 'every root gate and plugin smoke',
		typecheck: 'every workspace and scripts/',
		'ramp-gate-matrix': 'the ramp-gate suite in both modes',
		test: `full coverage suites: ${ci.groups
			.flatMap((g) => g.workspaces.map((w) => w.name))
			.sort()
			.join(', ')}`,
		'test-api': 'the full API suite with coverage',
		'test-web': 'the full web suite with coverage',
		'test-mta': 'the MTA suite with its Redis integration tests',
		'docker-build': `image builds: ${ci.images.map((image) => image.name).join(', ')}`,
		'sdk-java': 'the Java SDK build',
		'desktop-spa': 'the desktop SPA build',
	};
	return expectedJobs(ci)
		.filter((job) => describe[job])
		.map((job) => `${job}: ${describe[job]}`);
}

// ---- running ----------------------------------------------------------------

function display(step: Step): string {
	const [bin, ...args] = step.command;
	const shown = args.length > 12 ? [...args.slice(0, 10), `… (+${args.length - 10})`] : args;
	return `${step.cwd ? `(in ${step.cwd}) ` : ''}${[bin, ...shown].join(' ')}`;
}

export type Spawn = (step: Step) => number;

export const spawnStep =
	(root: string): Spawn =>
	(step) => {
		const env = { ...process.env };
		for (const [key, value] of Object.entries(step.env ?? {}))
			if (value === undefined) delete env[key];
			else env[key] = value;
		const [bin, ...args] = step.command;
		const run = spawnSync(bin!.includes('/') ? resolve(root, bin!) : bin!, args, {
			cwd: join(root, step.cwd ?? ''),
			env,
			stdio: 'inherit',
		});
		if (run.error) {
			console.error(`check:changed: could not start ${bin}: ${run.error.message}`);
			return 1;
		}
		return run.status ?? 1;
	};

export function runPlan(
	plan: Plan,
	spawn: Spawn,
	log: (line: string) => void = console.info
): { name: string; ok: boolean; seconds: string }[] {
	return plan.steps.map((step) => {
		log(`\n> ${step.name}\n  ${display(step)}`);
		const started = performance.now();
		const ok = spawn(step) === 0;
		return { name: step.name, ok, seconds: ((performance.now() - started) / 1000).toFixed(1) };
	});
}

function readWorkspaces(root: string, affectedEnv: Record<string, string>) {
	const all = turboJson(root, ['ls', '--output=json'], {});
	const affected = turboJson(root, ['ls', '--affected', '--output=json'], affectedEnv);
	const workspaces = all.map((item): WorkspaceInfo => {
		const manifest = JSON.parse(readFileSync(join(root, item.path, 'package.json'), 'utf8')) as {
			scripts?: Record<string, string>;
		};
		return { name: item.name, directory: item.path, scripts: manifest.scripts ?? {} };
	});
	return { workspaces, affected: new Set(affected.map((item) => item.name)) };
}

export function main(argv: string[], root = ROOT): number {
	const dryRun = argv.includes('--dry-run');
	const refs = argv.filter((arg) => arg !== '--dry-run' && arg !== '--');
	if (refs.length > 1 || refs.some((arg) => arg.startsWith('-')))
		throw new CheckChangedError('usage: bun run check:changed [<ref>] [-- --dry-run]');
	const mergeBase = resolveMergeBase(root, refs[0] ?? 'origin/main');
	const changes = changedFiles(root, mergeBase);
	if (changes.length === 0) {
		console.info(`check:changed: no changes since ${mergeBase.slice(0, 12)}.`);
		return 0;
	}
	const { workspaces, affected } = readWorkspaces(root, { TURBO_SCM_BASE: mergeBase });
	const turbo = parseJsonc(readFileSync(join(root, 'turbo.json'), 'utf8')) as {
		tasks: Record<string, TurboTaskConfig>;
	};
	const plan = buildPlan({
		mergeBase,
		changes,
		workspaces,
		affected,
		turboTasks: turbo.tasks,
		images: JSON.parse(readFileSync(join(root, '.github/docker-images.json'), 'utf8')),
		listDirectory: (directory) => {
			const path = join(root, directory);
			return existsSync(path) ? readdirSync(path) : [];
		},
		vitestBin: (directory) =>
			existsSync(join(root, directory, 'node_modules/.bin/vitest'))
				? join(directory, 'node_modules/.bin/vitest')
				: 'node_modules/.bin/vitest',
		env: process.env,
	});

	console.info(
		`check:changed: ${changes.length} changed files since ${mergeBase.slice(0, 12)}, ` +
			`${affected.size} affected workspaces`
	);
	if (dryRun) {
		for (const step of plan.steps) console.info(`  ${step.name}\n    ${display(step)}`);
	}
	const results = dryRun ? [] : runPlan(plan, spawnStep(root));

	console.info('\ncheck:changed summary');
	for (const result of results)
		console.info(`  ${result.ok ? 'pass' : 'FAIL'}  ${result.name}  ${result.seconds}s`);
	for (const note of plan.notes) console.info(`  note  ${note}`);
	console.info('  CI also runs:');
	for (const line of ciAlsoRuns(plan)) console.info(`    ${line}`);
	return results.every((result) => result.ok) ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		if (!(error instanceof CheckChangedError)) throw error;
		console.error(error.message);
		process.exitCode = 1;
	}
}
