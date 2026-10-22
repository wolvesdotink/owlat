/**
 * `bun run dev:stack`: a complete local Owlat for this checkout.
 *
 *   bun run dev:stack [up] [--no-seed]   start (or reattach to) the stack
 *   bun run dev:stack down [--volumes]   stop this checkout's containers
 *   bun run dev:stack status             ports and container state
 *   bun run dev:stack ports              the resolved ports only
 *
 * `up` starts the Convex backend and Redis in a Compose project of their own,
 * pushes the functions, seeds demo data, then runs the Convex watcher and
 * Nuxt in the foreground until Ctrl-C. The containers keep running after
 * Ctrl-C so the next start is quick; `down` stops them and keeps the data,
 * `down --volumes` deletes it. Ports derive from the checkout path
 * (scripts/dev-stack/config.ts); OWLAT_PORT_OFFSET overrides them.
 * docs/operations/development.md is the runbook.
 */

import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
	DevStackConfigError,
	describePorts,
	resolveDevStackConfig,
	webEnv,
	type DevStackConfig,
} from './dev-stack/config';
import { selfHostedCliEnv } from './dev-stack/convexTarget';
import { parseAdminKey, writeEnvFile } from './dev-stack/envFile';
import { syncStage, watchStage } from './dev-stack/stage';
import {
	composeEnvEntries,
	devStackPaths,
	loadOrCreateSecrets,
	type DevStackPaths,
} from './dev-stack/state';
import { supervise } from './dev-stack/supervise';
import { runUp, type StackOps } from './dev-stack/up';

const root = realpathSync(join(import.meta.dir, '..'));
const paths: DevStackPaths = devStackPaths(root);
const convexBin = join(root, 'node_modules', '.bin', 'convex');

function isLinkedWorktree(): boolean {
	return lstatSync(join(root, '.git'), { throwIfNoEntry: false })?.isFile() ?? false;
}

// Resolved in main(), inside its error handling: a bad OWLAT_PORT_OFFSET is a
// usage error, not a crash.
let config: DevStackConfig;

function composeArgs(...args: string[]): string[] {
	return [
		'compose',
		'--project-name',
		config.project,
		'--file',
		paths.composeFile,
		'--env-file',
		paths.composeEnv,
		...args,
	];
}

/** Runs a command with inherited output; rejects on a non-zero exit. */
function run(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? root,
			env: options.env ?? process.env,
			stdio: [options.input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} ${args[0] ?? ''} failed (${signal ?? `exit ${code}`})`));
		});
	});
}

function capture(
	command: string,
	args: string[]
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function portInUse(port: number): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const server = createServer();
		server.once('error', () => resolvePromise(true));
		server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
			server.close(() => resolvePromise(false));
		});
	});
}

function writeComposeEnv(): void {
	const secrets = loadOrCreateSecrets(paths.secretsFile);
	writeEnvFile(paths.composeEnv, composeEnvEntries(config, secrets));
}

function runningServices(): Set<string> {
	const result = capture('docker', composeArgs('ps', '--status', 'running', '--services'));
	if (result.status !== 0) {
		throw new Error(`docker compose ps failed:\n${result.stderr.trim()}`);
	}
	return new Set(
		result.stdout
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
	);
}

function cliEnv(adminKey: string): NodeJS.ProcessEnv {
	return selfHostedCliEnv(process.env, config.urls.convex, adminKey);
}

async function up(seed: boolean): Promise<number> {
	const secrets = loadOrCreateSecrets(paths.secretsFile);
	writeComposeEnv();
	let adminKey = '';
	const ops: StackOps = {
		log: (line) => console.log(line),
		runningServices: async () => runningServices(),
		portInUse,
		composeUp: () => run('docker', composeArgs('up', '--detach', '--wait')),
		adminKey: async () => {
			const result = capture(
				'docker',
				composeArgs('exec', '-T', 'convex', './generate_admin_key.sh')
			);
			const key = result.status === 0 ? parseAdminKey(result.stdout) : null;
			if (!key)
				throw new Error(`Could not read an admin key from the backend:\n${result.stderr.trim()}`);
			adminKey = key;
			return key;
		},
		syncStage: () => syncStage(paths.apiDir, paths.stageApi),
		writeStageEnv: (entries) => writeEnvFile(paths.stageEnv, entries),
		setDeploymentEnv: (entries) => {
			// Through stdin, so the secrets never appear in a process listing.
			const input = Object.entries(entries)
				.map(([key, value]) => `${key}=${value}`)
				.join('\n');
			return run(convexBin, ['env', 'set', '--force'], {
				cwd: paths.stageApi,
				env: cliEnv(adminKey),
				input: `${input}\n`,
			});
		},
		pushOnce: () =>
			run(convexBin, ['dev', '--once', '--typecheck', 'disable', '--codegen', 'disable'], {
				cwd: paths.stageApi,
				env: cliEnv(adminKey),
			}),
		seed: () => run(process.execPath, [join(root, 'scripts', 'dev-seed.ts')], { env: process.env }),
		runForeground: () => {
			const stopWatching = watchStage(paths.apiDir, paths.stageApi, (result) => {
				if (result instanceof Error) console.error(`[stage] sync failed: ${result.message}`);
				else if (result.copied + result.removed > 0) {
					console.log(`[stage] ${result.copied} copied, ${result.removed} removed`);
				}
			});
			return supervise(
				[
					{
						name: 'convex',
						command: convexBin,
						args: ['dev', '--typecheck', 'disable', '--codegen', 'disable'],
						cwd: paths.stageApi,
						env: cliEnv(adminKey),
					},
					{
						name: 'web',
						command: process.execPath,
						args: ['run', 'dev'],
						cwd: join(root, 'apps', 'web'),
						env: { ...process.env, ...webEnv(config) },
					},
				],
				stopWatching
			);
		},
	};
	return runUp(config, secrets, { seed }, ops);
}

async function down(volumes: boolean): Promise<number> {
	writeComposeEnv();
	await run('docker', composeArgs('down', ...(volumes ? ['--volumes'] : [])));
	console.log(
		volumes
			? "Stopped and deleted this checkout's stack data."
			: 'Stopped. Data kept; `bun run dev:stack` resumes it.'
	);
	return 0;
}

async function status(): Promise<number> {
	console.log(describePorts(config));
	writeComposeEnv();
	await run('docker', composeArgs('ps'));
	return 0;
}

async function main(argv: string[]): Promise<number> {
	config = resolveDevStackConfig({
		explicit: process.env['OWLAT_PORT_OFFSET'],
		root,
		linkedWorktree: isLinkedWorktree(),
	});
	const flags = new Set(argv.filter((arg) => arg.startsWith('-')));
	const [command = 'up', ...rest] = argv.filter((arg) => !arg.startsWith('-'));
	const known: Record<string, string[]> = {
		up: ['--no-seed'],
		down: ['--volumes'],
		status: [],
		ports: [],
	};
	const allowed = known[command];
	const unknown = [...flags].filter((flag) => !allowed?.includes(flag));
	if (flags.has('--help') || flags.has('-h') || !allowed || rest.length > 0 || unknown.length > 0) {
		console.log('Usage: bun run dev:stack [up [--no-seed] | down [--volumes] | status | ports]');
		return flags.has('--help') || flags.has('-h') ? 0 : 2;
	}
	switch (command) {
		case 'down':
			return down(flags.has('--volumes'));
		case 'status':
			return status();
		case 'ports':
			console.log(describePorts(config));
			return 0;
		default:
			return up(!flags.has('--no-seed'));
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`\n✗ ${message}`);
	process.exitCode = error instanceof DevStackConfigError ? 2 : 1;
}
