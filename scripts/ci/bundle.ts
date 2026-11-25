/**
 * `bun run ci:bundle`: the web bundle budgets that CI's Docker Build (web) job
 * checks, run on this checkout. It builds the web app the way
 * apps/web/Dockerfile does, runs scripts/check-bundle-budget.ts (the entry
 * closure) and scripts/report-bundle-closures.ts (every page and lazily loaded
 * chunk against scripts/bundle-closure-budgets.txt), prints the failures of
 * both last, and removes the build output that was not there before the run.
 *
 * The build needs several GiB of memory, so the run refuses to start when less
 * is available: on a shared machine an out-of-memory kill takes other sessions
 * down with it. `CI_BUNDLE_MIN_AVAILABLE_GIB` overrides the threshold.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem, platform } from 'node:os';
import { join } from 'node:path';

const TOOL = 'ci:bundle';
const ROOT = join(import.meta.dirname, '../..');
const GIB = 1024 ** 3;

/** The heap the web Dockerfile gives `nuxt build`. */
export const BUILD_HEAP_MIB = 4096;
/** The capped heap plus node's own memory outside it. */
export const MIN_AVAILABLE_GIB = 5;
export const MIN_AVAILABLE_ENV = 'CI_BUNDLE_MIN_AVAILABLE_GIB';

export interface Step {
	readonly label: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Repo-relative. */
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
}

/** The web image's build stage, in its order. */
export const BUILD_STEPS: readonly Step[] = [
	{
		label: 'build provider-kit and plugin-kit',
		command: 'bun',
		args: ['run', 'plugins:prepare'],
		cwd: '.',
	},
	{
		label: 'nuxi prepare in packages/ui',
		command: 'npx',
		args: ['nuxi', 'prepare'],
		cwd: 'packages/ui',
	},
	{
		label: 'nuxt build in apps/web',
		command: 'npx',
		args: ['nuxt', 'build'],
		cwd: 'apps/web',
		env: { NITRO_PRESET: 'node-server', NODE_OPTIONS: `--max-old-space-size=${BUILD_HEAP_MIB}` },
	},
];

/** The two blocking budget steps of .github/workflows/test.yml. */
export const CHECK_STEPS: readonly Step[] = [
	{
		label: 'entry closure',
		command: 'bun',
		args: ['scripts/check-bundle-budget.ts', 'apps/web/.output'],
		cwd: '.',
	},
	{
		label: 'page and lazy-chunk closures',
		command: 'bun',
		args: ['scripts/report-bundle-closures.ts', 'apps/web/.output'],
		cwd: '.',
	},
];

/**
 * Everything the steps write, repo-relative. A production `nuxt build` puts its
 * build directory under node_modules/.cache when apps/web/.nuxt (the dev
 * server's and the web typecheck's) exists, and into apps/web/.nuxt otherwise.
 * A path that existed before the run is kept and holds this run's build.
 */
export const WRITTEN: readonly string[] = [
	'apps/web/.output',
	'apps/web/.nuxt',
	'apps/web/node_modules/.cache/nuxt/.nuxt',
	'packages/ui/.nuxt',
	'packages/provider-kit/dist',
	'packages/plugin-kit/dist',
];

/** MemAvailable from /proc/meminfo, else `fallback` (macOS, Windows). */
export function availableBytes(meminfo: string | undefined, fallback: number): number {
	const match = meminfo?.match(/^MemAvailable:\s+(\d+) kB$/m);
	return match ? Number(match[1]) * 1024 : fallback;
}

/**
 * What macOS can hand a new process from `vm_stat` output: free, speculative
 * and inactive pages, the estimate psutil reports as available there.
 * `os.freemem()` on darwin is the kernel's free count alone (free plus
 * speculative), so on a Mac that has been running a while it reports a
 * fraction of what the system would reclaim for a build. Purgeable pages are
 * left out: they sit in the active and inactive queues already, so adding them
 * would count some pages twice. Undefined when the output lacks a field.
 */
export function vmStatAvailableBytes(vmStat: string | undefined): number | undefined {
	const pageSize = vmStat?.match(/page size of (\d+) bytes/)?.[1];
	if (vmStat === undefined || pageSize === undefined) return undefined;
	let pages = 0;
	for (const field of ['free', 'speculative', 'inactive']) {
		const count = new RegExp(`^Pages ${field}:\\s+(\\d+)\\.?$`, 'm').exec(vmStat)?.[1];
		if (count === undefined) return undefined;
		pages += Number(count);
	}
	return pages * Number(pageSize);
}

export function minAvailableGiB(env: Readonly<Record<string, string | undefined>>): number {
	const raw = env[MIN_AVAILABLE_ENV];
	if (raw === undefined || raw === '') return MIN_AVAILABLE_GIB;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${MIN_AVAILABLE_ENV} must be a number of GiB, not "${raw}".`);
	}
	return value;
}

/** The sentence the run stops with, or undefined when there is room. */
export function memoryRefusal(available: number, minGiB: number): string | undefined {
	if (available >= minGiB * GIB) return undefined;
	return (
		`${TOOL}: only ${(available / GIB).toFixed(1)} GiB of memory is available and the production ` +
		`web build needs ${minGiB} GiB, so it did not start. Stop a dev server, typecheck or full ` +
		`test run first (${MIN_AVAILABLE_ENV} sets the threshold).`
	);
}

function readMeminfo(): string | undefined {
	try {
		return readFileSync('/proc/meminfo', 'utf8');
	} catch {
		return undefined;
	}
}

function readVmStat(): string | undefined {
	if (platform() !== 'darwin') return undefined;
	const result = spawnSync('vm_stat', { encoding: 'utf8' });
	return result.status === 0 ? result.stdout : undefined;
}

/** Exit status of `step`; 130 when it was interrupted. */
function runStep(step: Step, stderr: 'inherit' | 'pipe'): { code: number; stderr: string } {
	console.info(`\n== ${TOOL}: ${step.label}`);
	const result = spawnSync(step.command, step.args, {
		cwd: join(ROOT, step.cwd),
		env: { ...process.env, ...step.env },
		stdio: ['inherit', 'inherit', stderr],
		encoding: 'utf8',
	});
	const code = result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
	return { code, stderr: result.stderr ?? '' };
}

function run(): number {
	let minGiB: number;
	try {
		minGiB = minAvailableGiB(process.env);
	} catch (error) {
		console.error(`${TOOL}: ${(error as Error).message}`);
		return 2;
	}
	const refusal = memoryRefusal(
		availableBytes(readMeminfo(), vmStatAvailableBytes(readVmStat()) ?? freemem()),
		minGiB
	);
	if (refusal !== undefined) {
		console.error(refusal);
		return 2;
	}

	const fresh = WRITTEN.filter((path) => !existsSync(join(ROOT, path)));
	// Ctrl-C stops the running step; the run itself stays to clean up.
	process.on('SIGINT', () => {});
	try {
		for (const step of BUILD_STEPS) {
			const { code } = runStep(step, 'inherit');
			if (code !== 0) {
				console.error(`${TOOL}: ${step.label} failed (exit ${code}).`);
				return code;
			}
		}
		// Both checks run, as in CI; their failures are printed after both
		// reports, so the entry check's advice is not lost above the long table.
		const results = CHECK_STEPS.map((step) => ({ step, ...runStep(step, 'pipe') }));
		const failed = results.filter(({ code }) => code !== 0);
		if (failed.length === 0) {
			console.info(`\n${TOOL}: the web bundle is within every budget.`);
			return 0;
		}
		for (const { step, stderr } of failed) {
			console.error(`\n== ${TOOL}: ${step.label} failed`);
			process.stderr.write(stderr);
		}
		return Math.max(...failed.map(({ code }) => code));
	} finally {
		for (const path of fresh) rmSync(join(ROOT, path), { recursive: true, force: true });
	}
}

if (import.meta.main) process.exit(run());
