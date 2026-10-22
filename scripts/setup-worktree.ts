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
 * `setup-running` (holds `<pid>-<run id>`) while it works, then `setup-done` or
 * `setup-failed` (with the reason). A second run while one is in progress
 * leaves it alone. Uses Node built-ins only: it runs before dependencies exist.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
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
	/**
	 * Unique to this run, `<pid>-<random>`: what the marker holds, so a run
	 * only ever replaces or removes a marker it can name.
	 */
	readonly token: string;
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

function newRunToken(pid: number): string {
	return `${pid}-${randomBytes(6).toString('hex')}`;
}

function readMarker(path: string): string | null {
	try {
		return readFileSync(path, 'utf8').trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

/**
 * Creates `path` holding `content` only if it does not exist. The content is
 * written first and linked into place, so a reader never sees a half-written
 * marker.
 */
function createExclusive(path: string, content: string, token: string): boolean {
	const temp = `${path}.${token}.tmp`;
	writeFileSync(temp, `${content}\n`);
	try {
		linkSync(temp, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	} finally {
		rmSync(temp, { force: true });
	}
}

function holderIsAlive(deps: SetupDeps, content: string): boolean {
	const pid = Number.parseInt(content, 10);
	return Number.isInteger(pid) && pid !== deps.pid && deps.isAlive(pid);
}

type Acquired = 'acquired' | 'already-running' | 'blocked';

const ACQUIRE_ATTEMPTS = 5;

/**
 * Takes the `setup-running` marker. Another live setup holding it wins. A
 * marker left by a process that no longer exists is taken over, and the
 * takeover of one particular stale marker is serialized by a claim file named
 * after its content: of several runs that saw the same dead holder, only the
 * one that creates the claim and still finds that same content replaces it.
 * The others find a live holder on their next look and stand down.
 */
function acquire(deps: SetupDeps, dir: string, running: string): Acquired {
	for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
		if (createExclusive(running, deps.token, deps.token)) return 'acquired';
		const seen = readMarker(running);
		if (seen === null) continue;
		if (holderIsAlive(deps, seen)) {
			deps.log(`setup is already running (${seen}); wait for .owlat-dev/setup-done`);
			return 'already-running';
		}
		const claimId = seen.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64) || 'empty';
		const claim = join(dir, `setup-takeover-${claimId}`);
		if (!createExclusive(claim, deps.token, deps.token)) {
			const claimer = readMarker(claim);
			if (claimer === null) continue;
			if (holderIsAlive(deps, claimer)) {
				deps.log(`another setup (${claimer}) is taking over; wait for .owlat-dev/setup-done`);
				return 'already-running';
			}
			// The claim is held only across a few synchronous file operations,
			// so a dead claimer means a crash right there; nothing can tell
			// whether its takeover finished, so a person decides.
			deps.log(`a setup died while taking over; delete ${claim} and run again`);
			return 'blocked';
		}
		try {
			if (readMarker(running) !== seen) continue;
			const temp = `${running}.${deps.token}.tmp`;
			writeFileSync(temp, `${deps.token}\n`);
			renameSync(temp, running);
			return 'acquired';
		} finally {
			rmSync(claim, { force: true });
		}
	}
	deps.log('the setup marker kept changing; run setup again');
	return 'blocked';
}

/** Removes `setup-running` only while it still names this run. */
function releaseMarker(running: string, token: string): void {
	if (readMarker(running) === token) rmSync(running, { force: true });
}

/**
 * Ends a run that is interrupted between steps: records why and frees the
 * marker, but only when this run holds it.
 */
function abandonRun(worktree: string, token: string, reason: string): void {
	const markers = markerPaths(worktree);
	if (readMarker(markers.running) !== token) return;
	writeFileSync(markers.failed, `${reason}\n`);
	releaseMarker(markers.running, token);
}

export type SetupOutcome = 'done' | 'failed' | 'already-running' | 'blocked';

export async function runSetup(
	deps: SetupDeps,
	cancelled: () => string | null = () => null
): Promise<SetupOutcome> {
	const markers = markerPaths(deps.worktree);
	mkdirSync(markers.dir, { recursive: true });
	const acquired = acquire(deps, markers.dir, markers.running);
	if (acquired !== 'acquired') return acquired;
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
	releaseMarker(markers.running, deps.token);
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
	const token = newRunToken(process.pid);
	let cancelSignal: string | null = null;
	let active: ReturnType<typeof spawn> | undefined;
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.on(signal, () => {
			cancelSignal = signal;
			// The step's exit then ends setup with a failed marker; with no step
			// running there is nothing to wait for.
			if (active) active.kill(signal);
			else {
				abandonRun(worktree, token, `Cancelled by ${signal}.`);
				process.exit(1);
			}
		});
	}
	const outcome = await runSetup(
		{
			worktree,
			mainCheckout: findMainCheckout(worktree, process.env),
			pid: process.pid,
			token,
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
	} else if (outcome === 'blocked') {
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
