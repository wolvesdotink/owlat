/**
 * `bun run setup:worktree`: makes a fresh checkout usable. T3 Code runs it on
 * worktree creation (t3.json); run it by hand after `git worktree add`.
 *
 *   1. Links `.env` and `.env.local` from the main checkout (only when the
 *      worktree has no file of its own; a real file is never replaced).
 *   2. `bun install --frozen-lockfile`: installs exactly the lockfile, and
 *      fails rather than rewriting it when it is stale.
 *   3. Builds the workspace packages the web app imports from their `dist/`
 *      (plugin and provider kits and the rest of `@owlat/web`'s dependencies),
 *      without which `nuxt dev` and the typechecks fail.
 *
 * Progress is visible to agents through markers in `.owlat-dev/`:
 * `setup-running` (holds the PID) while it works, then `setup-done` or
 * `setup-failed` (with the reason). A second run while one is in progress
 * leaves it alone. Uses Node built-ins only: it runs before dependencies exist.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_FILES = ['.env', '.env.local'] as const;
const MARKER_DIR = '.owlat-dev';
const OUTPUT_TAIL_CHARS = 8_000;

export interface Step {
	readonly label: string;
	readonly command: string;
	readonly args: readonly string[];
}

export function setupSteps(worktree: string): Step[] {
	return [
		{ label: 'install', command: 'bun', args: ['install', '--frozen-lockfile'] },
		{
			label: 'build web dependencies',
			command: join(worktree, 'node_modules', '.bin', 'turbo'),
			args: ['run', 'build', '--filter=@owlat/web^...'],
		},
	];
}

export interface StepResult {
	readonly code: number;
	readonly output: string;
}

export interface SetupDeps {
	readonly worktree: string;
	/** Main checkout to link env files from; null when there is none. */
	readonly mainCheckout: string | null;
	readonly pid: number;
	isAlive(pid: number): boolean;
	runStep(step: Step, cwd: string): Promise<StepResult>;
	log(line: string): void;
}

export function markerPaths(worktree: string) {
	const dir = join(worktree, MARKER_DIR);
	return {
		dir,
		running: join(dir, 'setup-running'),
		done: join(dir, 'setup-done'),
		failed: join(dir, 'setup-failed'),
	};
}

/**
 * Links each env file the main checkout has and the worktree lacks. An
 * existing symlink is re-pointed; a real file stays, so a worktree's own
 * settings (and the main checkout's real files, when this runs there) are
 * never deleted.
 */
export function linkEnvFiles(
	worktree: string,
	mainCheckout: string | null,
	log: (line: string) => void
): void {
	if (!mainCheckout || resolve(mainCheckout) === resolve(worktree)) return;
	for (const file of ENV_FILES) {
		const source = join(mainCheckout, file);
		const sourceStat = lstatSync(source, { throwIfNoEntry: false });
		if (!sourceStat?.isFile()) continue;
		const target = join(worktree, file);
		const existing = lstatSync(target, { throwIfNoEntry: false });
		if (existing && !existing.isSymbolicLink()) {
			log(`kept ${file} (this worktree has its own)`);
			continue;
		}
		if (existing) rmSync(target);
		symlinkSync(source, target);
		log(`linked ${file} from the main checkout`);
	}
}

/**
 * Takes the `setup-running` marker. Returns false when another live setup
 * holds it; a marker left by a process that no longer exists is taken over.
 */
function acquire(deps: SetupDeps, running: string): boolean {
	try {
		writeFileSync(running, `${deps.pid}\n`, { flag: 'wx' });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const holder = Number.parseInt(readFileSync(running, 'utf8'), 10);
	if (Number.isInteger(holder) && holder !== deps.pid && deps.isAlive(holder)) {
		deps.log(`setup is already running (pid ${holder}); wait for .owlat-dev/setup-done`);
		return false;
	}
	writeFileSync(running, `${deps.pid}\n`);
	return true;
}

export type SetupOutcome = 'done' | 'failed' | 'already-running';

export async function runSetup(
	deps: SetupDeps,
	cancelled: () => string | null = () => null
): Promise<SetupOutcome> {
	const markers = markerPaths(deps.worktree);
	mkdirSync(markers.dir, { recursive: true });
	if (!acquire(deps, markers.running)) return 'already-running';
	rmSync(markers.done, { force: true });
	rmSync(markers.failed, { force: true });

	let failure: string | null = null;
	try {
		linkEnvFiles(deps.worktree, deps.mainCheckout, deps.log);
		for (const step of setupSteps(deps.worktree)) {
			deps.log(`${step.label}: ${step.command} ${step.args.join(' ')}`);
			const result = await deps.runStep(step, deps.worktree);
			const reason = cancelled();
			if (reason) {
				failure = `Cancelled by ${reason} during ${step.label}.`;
				break;
			}
			if (result.code !== 0) {
				const tail = result.output.trimEnd().split('\n').slice(-30).join('\n');
				failure = `${step.label} exited with code ${result.code}.\n${tail}`;
				break;
			}
		}
	} catch (error) {
		failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
	}

	if (failure === null) writeFileSync(markers.done, '');
	else writeFileSync(markers.failed, `${failure}\n`);
	rmSync(markers.running, { force: true });
	return failure === null ? 'done' : 'failed';
}

/** The main checkout: T3 Code passes it; otherwise git's common directory says. */
export function findMainCheckout(worktree: string, env: NodeJS.ProcessEnv): string | null {
	const fromT3 = env['T3CODE_PROJECT_ROOT']?.trim();
	if (fromT3) return fromT3;
	const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
		cwd: worktree,
		encoding: 'utf8',
	});
	if (result.status !== 0) return null;
	const commonDir = result.stdout.trim();
	const main = dirname(commonDir);
	return existsSync(join(main, 'package.json')) ? main : null;
}

async function main(): Promise<void> {
	const worktree = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
	let cancelSignal: string | null = null;
	let active: ReturnType<typeof spawn> | undefined;
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.on(signal, () => {
			cancelSignal = signal;
			// The step's exit then ends setup with a failed marker; with no step
			// running there is nothing to wait for.
			if (active) active.kill(signal);
			else {
				const markers = markerPaths(worktree);
				writeFileSync(markers.failed, `Cancelled by ${signal}.\n`);
				rmSync(markers.running, { force: true });
				process.exit(1);
			}
		});
	}
	const outcome = await runSetup(
		{
			worktree,
			mainCheckout: findMainCheckout(worktree, process.env),
			pid: process.pid,
			isAlive: (pid) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === 'EPERM';
				}
			},
			// No one answers prompts here: stdin stays closed so a prompt fails
			// instead of hanging, and output is piped so a failure keeps its tail.
			runStep: (step, cwd) =>
				new Promise((resolveStep) => {
					const child = spawn(step.command, [...step.args], {
						cwd,
						stdio: ['ignore', 'pipe', 'pipe'],
					});
					active = child;
					let output = '';
					const collect = (target: NodeJS.WriteStream) => (chunk: Buffer) => {
						target.write(chunk);
						output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
					};
					child.stdout.on('data', collect(process.stdout));
					child.stderr.on('data', collect(process.stderr));
					child.once('error', (error) => resolveStep({ code: 1, output: error.message }));
					child.once('close', (code) => {
						active = undefined;
						resolveStep({ code: code ?? 1, output });
					});
				}),
			log: (line) => console.info(`[setup-worktree] ${line}`),
		},
		() => cancelSignal
	);
	if (outcome === 'failed') {
		console.error(`[setup-worktree] failed; see ${markerPaths(worktree).failed}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
