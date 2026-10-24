/**
 * `owlat-setup support-bundle [--lines N] [--output FILE|-]` — one archive for
 * a bug report.
 *
 * Collects, read-only, what a maintainer asks for first: the doctor report,
 * `docker compose ps`, the last N log lines of every service, the versions in
 * play, the migration ledger and the updater's last rollout verdict. Each
 * section is projected by `lib/supportBundleSections.ts` before it is held
 * anywhere; raw logs and raw command output are never written to disk. A source
 * that cannot be read becomes an `unavailable` section with a reason code, so a
 * half-broken install (the usual reason to run this) still yields a bundle.
 *
 * Read-only means: no MTA identity recheck (doctor's default), no
 * `docker compose up`, no deploy and no migration start. The migration read is
 * `convex run` of an internal query through the `convex-deploy` image with
 * `--no-deps`, so it starts nothing the stack does not already run.
 *
 * `scripts/owlat support-bundle` runs this in the setup image with the Docker
 * socket and passes `--output -`, then writes stdout to a host file itself, so
 * the archive can land anywhere on the host, not only under the install dir.
 */

import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseComposePs } from '@owlat/shared/containerHealth';
import { readEnv, type EnvMap } from '../lib/env';
import { parseArgv } from '../lib/argv';
import { createTarGz, type TarEntry } from '../lib/tarball';
import { runBounded, type CommandOptions, type CommandResult } from '../lib/boundedCommand';
import {
	SUPPORT_BUNDLE_SCHEMA_VERSION,
	isBundleServiceName,
	projectComposeServices,
	projectDoctorReport,
	projectMigrationState,
	projectRolloutRecord,
	projectServiceLog,
	versionToken,
	type BundleComposeService,
	type BundleMigrationState,
	type SectionReason,
	type SectionResult,
} from '../lib/supportBundleSections';
import { collectDoctorReport } from './doctorRun';

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 5000;

/** The internal query the migration section runs (apps/api/convex/migrations/admin.ts). */
const MIGRATION_STATE_FUNCTION = 'migrations/admin:supportBundleState';

const MIB = 1024 * 1024;

/** The runtime edges of a bundle run, injectable so the whole run is testable. */
export interface SupportBundleIo {
	docker(args: readonly string[], options: CommandOptions): Promise<CommandResult>;
	now(): Date;
	/** Progress and errors, on stderr: stdout may be the archive. */
	log(line: string): void;
	writeStdout(data: Uint8Array): Promise<void>;
	isStdoutTty(): boolean;
}

const NODE_IO: SupportBundleIo = {
	docker: (args, options) => runBounded('docker', args, options),
	now: () => new Date(),
	log: (line) => console.error(line),
	writeStdout: (data) =>
		new Promise((done, fail) => {
			process.stdout.write(data, (error) => (error ? fail(error) : done()));
		}),
	isStdoutTty: () => process.stdout.isTTY === true,
};

function failureReason(result: CommandResult): SectionReason {
	if (result.code === 127) return 'docker_unavailable';
	if (result.timedOut) return 'timed_out';
	return 'command_failed';
}

/** One file per section: its status first, then its data. */
function sectionFile(result: SectionResult, data: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ ...result, ...data }, null, 2)}\n`;
}

export interface SupportBundleOptions {
	lines: number;
	cliVersion: string;
}

export interface SupportBundle {
	/** Directory every member sits under, e.g. `owlat-support-20261024T101500Z`. */
	root: string;
	entries: TarEntry[];
	sections: Record<string, SectionResult>;
}

function stamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
}

/** Collect every section of the bundle for the install in `owlatDir`. Never throws for a broken source. */
export async function collectSupportBundle(
	owlatDir: string,
	options: SupportBundleOptions,
	io: SupportBundleIo
): Promise<SupportBundle> {
	const now = io.now();
	const root = `owlat-support-${stamp(now)}`;
	const files: TarEntry[] = [];
	const sections: Record<string, SectionResult> = {};
	const add = (name: string, content: string) => files.push({ name: `${root}/${name}`, content });
	const docker = (args: readonly string[], overrides: Partial<CommandOptions> = {}) =>
		io.docker(args, {
			cwd: owlatDir,
			timeoutMs: 30_000,
			maxBytes: 2 * MIB,
			keep: 'head',
			...overrides,
		});

	const envPath = join(owlatDir, '.env');
	const env: EnvMap = existsSync(envPath) ? await readEnv(envPath).catch(() => ({})) : {};

	// Doctor, minus the MTA identity recheck (a write on the MTA's side).
	io.log('Collecting the doctor report…');
	try {
		const report = await collectDoctorReport(
			owlatDir,
			{
				async composePs(cwd) {
					const result = await io.docker(['compose', 'ps', '--format', 'json'], {
						cwd,
						timeoutMs: 30_000,
						maxBytes: 2 * MIB,
						keep: 'head',
					});
					if (result.code !== 0) throw new Error('docker compose ps failed');
					return result.output;
				},
				now: () => now,
				print: () => {},
			},
			undefined,
			{ recheckIdentity: false }
		);
		sections['doctor'] = { status: 'ok' };
		add('doctor.json', sectionFile(sections['doctor'], { report: projectDoctorReport(report) }));
	} catch {
		sections['doctor'] = { status: 'unavailable', reason: 'collection_failed' };
		add('doctor.json', sectionFile(sections['doctor']));
	}

	// Compose status, every container including stopped ones.
	io.log('Reading docker compose ps…');
	let services: BundleComposeService[] | null = null;
	const ps = await docker(['compose', 'ps', '--all', '--format', 'json']);
	if (ps.code !== 0) {
		sections['compose'] = { status: 'unavailable', reason: failureReason(ps) };
	} else if (ps.truncated) {
		sections['compose'] = { status: 'unavailable', reason: 'output_too_large' };
	} else {
		services = projectComposeServices(parseComposePs(ps.output));
		sections['compose'] = { status: 'ok' };
	}
	add('compose-ps.json', sectionFile(sections['compose'], services ? { services } : {}));

	// Migration ledger, through the deploy image's Convex CLI and the admin key.
	io.log('Reading the migration ledger…');
	let migrations: BundleMigrationState | null = null;
	const ledger = await docker(
		[
			'compose',
			'--profile',
			'deploy',
			'run',
			'--rm',
			'-T',
			'--no-deps',
			'convex-deploy',
			'convex',
			'run',
			MIGRATION_STATE_FUNCTION,
		],
		{ timeoutMs: 180_000 }
	);
	if (ledger.code !== 0) {
		sections['migrations'] = { status: 'unavailable', reason: failureReason(ledger) };
	} else if (ledger.truncated) {
		sections['migrations'] = { status: 'unavailable', reason: 'output_too_large' };
	} else {
		migrations = projectMigrationState(ledger.output);
		sections['migrations'] = migrations
			? { status: 'ok' }
			: { status: 'unavailable', reason: 'unparseable' };
	}
	add('migrations.json', sectionFile(sections['migrations'], migrations ? { ...migrations } : {}));

	// The updater's verdict on the last rollout.
	let rolloutText: string | null = null;
	let rolloutUnreadable = false;
	const rolloutPath = join(owlatDir, '.owlat-last-rollout.json');
	if (existsSync(rolloutPath)) {
		rolloutText = await readFile(rolloutPath, 'utf8').catch(() => {
			rolloutUnreadable = true;
			return null;
		});
	}
	const rollout = rolloutUnreadable
		? { result: { status: 'unavailable', reason: 'unreadable' } as SectionResult, rollout: null }
		: projectRolloutRecord(rolloutText);
	sections['rollout'] = rollout.result;
	add(
		'rollout.json',
		sectionFile(rollout.result, rollout.rollout ? { rollout: rollout.rollout } : {})
	);

	// Versions: this CLI, the configured release, the deployed functions, the
	// tag each container runs, and the Docker engine and Compose plugin.
	const engine = await docker(['version', '--format', '{{.Server.Version}}'], {
		timeoutMs: 15_000,
	});
	const compose = await docker(['compose', 'version', '--short'], { timeoutMs: 15_000 });
	sections['versions'] = { status: 'ok' };
	add(
		'versions.json',
		sectionFile(sections['versions'], {
			cli: versionToken(options.cliVersion),
			configured: versionToken(env['OWLAT_VERSION']),
			deployedFunctions: migrations?.deployedVersion ?? null,
			dockerEngine: engine.code === 0 ? versionToken(engine.output) : null,
			dockerCompose: compose.code === 0 ? versionToken(compose.output) : null,
			running: services
				? Object.fromEntries(services.map((service) => [service.service, service.imageTag]))
				: null,
		})
	);

	// Logs, the last N lines of every service compose lists.
	const logs: Array<
		{ service: string; file: string; lines: number; truncated: boolean } & SectionResult
	> = [];
	let skippedServices = 0;
	if (services) {
		const names = [...new Set(services.map((service) => service.service))];
		for (const service of names) {
			if (!isBundleServiceName(service)) {
				skippedServices++;
				continue;
			}
			io.log(`Reading the last ${options.lines} log lines of ${service}…`);
			const result = await docker(
				[
					'compose',
					'logs',
					'--no-color',
					'--no-log-prefix',
					'--timestamps',
					'--tail',
					String(options.lines),
					service,
				],
				{
					timeoutMs: 60_000,
					maxBytes: Math.min(options.lines * 16 * 1024, 8 * MIB),
					keep: 'tail',
					mergeStderr: true,
				}
			);
			const file = `logs/${service}.ndjson`;
			if (result.code !== 0) {
				logs.push({
					service,
					file,
					lines: 0,
					truncated: false,
					status: 'unavailable',
					reason: failureReason(result),
				});
				continue;
			}
			const projected = projectServiceLog(result.output, options.lines);
			add(file, projected.ndjson);
			logs.push({
				service,
				file,
				lines: projected.lines,
				truncated: result.truncated,
				status: 'ok',
			});
		}
		sections['logs'] = { status: 'ok' };
	} else {
		sections['logs'] = {
			status: 'unavailable',
			reason: sections['compose']?.reason ?? 'collection_failed',
		};
	}

	const manifest = {
		schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
		command: 'support-bundle',
		generatedAt: now.toISOString(),
		cliVersion: versionToken(options.cliVersion),
		options: { lines: options.lines },
		sections,
		logs,
		skippedServices,
		redaction:
			'Allowlist projection: log lines keep level, event name, error class/code, HTTP status, duration, length and a digest of the message; message text, addresses, subjects, stacks and unknown fields are dropped. Doctor messages are redacted for .env secrets and email addresses. Migration and rollout sections carry states, counts and timestamps, never error text.',
	};
	return {
		root,
		entries: [
			{ name: `${root}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
			...files,
		],
		sections,
	};
}

interface ParsedOptions {
	lines: number;
	output: string | null;
}

/** `--lines` and `--output` from the argv tail, or the reason they are invalid. */
export function parseSupportBundleArgs(args: readonly string[]): ParsedOptions | { error: string } {
	const { values, positional } = parseArgv(args);
	if (positional.length > 0) return { error: `Unexpected argument: ${positional[0]}` };
	const linesValue = values.get('--lines');
	let lines = DEFAULT_LOG_LINES;
	if (linesValue !== undefined) {
		if (!/^[0-9]+$/.test(linesValue)) return { error: '--lines takes a whole number' };
		lines = Number(linesValue);
		if (lines < 1 || lines > MAX_LOG_LINES) {
			return { error: `--lines must be between 1 and ${MAX_LOG_LINES}` };
		}
	}
	const output = values.get('--output') ?? null;
	if (output === '') return { error: '--output needs a file path, or - for stdout' };
	return { lines, output };
}

/** Write `data` to `path` owner-only, never leaving a partial file behind. */
async function writeArchive(path: string, data: Uint8Array): Promise<void> {
	const partial = `${path}.partial-${process.pid}`;
	try {
		await writeFile(partial, data, { mode: 0o600, flag: 'wx' });
		await rename(partial, path);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
}

export async function runSupportBundle(
	opts: { owlatDir: string; args?: string[]; cliVersion: string },
	io: SupportBundleIo = NODE_IO
): Promise<number> {
	const parsed = parseSupportBundleArgs(opts.args ?? []);
	if ('error' in parsed) {
		io.log(`Error: ${parsed.error}`);
		io.log('Usage: owlat-setup support-bundle [--lines N] [--output FILE|-]');
		return 1;
	}
	const toStdout = parsed.output === '-';
	if (toStdout && io.isStdoutTty()) {
		io.log('Error: refusing to write the archive to a terminal; redirect stdout to a file.');
		return 1;
	}
	const target = toStdout
		? null
		: resolve(parsed.output ?? `owlat-support-${stamp(io.now())}.tar.gz`);
	if (target && existsSync(target)) {
		io.log(`Error: ${target} already exists; choose another --output.`);
		return 1;
	}

	const bundle = await collectSupportBundle(
		opts.owlatDir,
		{ lines: parsed.lines, cliVersion: opts.cliVersion },
		io
	);
	const archive = createTarGz(bundle.entries, io.now());
	if (target) await writeArchive(target, archive);
	else await io.writeStdout(archive);

	for (const [name, result] of Object.entries(bundle.sections)) {
		io.log(`  ${name}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
	}
	io.log(target ? `Support bundle written to ${target}` : 'Support bundle written to stdout.');
	io.log('Review it before you share it: it lists your services, versions and doctor findings.');
	return 0;
}
