/**
 * Launches the packaged app and owns it until it is gone.
 *
 * The app runs in its own process group, so whatever it starts stays
 * reachable: the AppImage runtime, WebKit's helper processes and, after an
 * update, the relaunched binary, which `restart()` spawns before the old
 * process exits. They all inherit the output pipes, so the run is over when the
 * last of them closes them (the child's `close` event), not when the first
 * process exits.
 *
 * A run ends in one of two ways: the app finishes and closes its output, or
 * the deadline passes and the group is stopped (SIGTERM, then SIGKILL after a
 * grace period). Whether reaching the deadline is a failure is for the caller
 * to decide: for a fixture build it means the scenario hung, for a liveness
 * run of a release build it is the expected outcome. After the output closes,
 * the group gets a SIGKILL in case something let go of its pipes and kept
 * running; nothing outside the group started here is ever signalled.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { fatalMatch, parseReport, type Report } from './report';

export interface LaunchSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly cwd?: string;
	/** When the group is stopped if it has not finished by itself. */
	readonly deadlineMs: number;
	/** Between SIGTERM and SIGKILL once the deadline has passed. */
	readonly graceMs?: number;
}

export interface RunResult {
	/** Every output line, stdout and stderr interleaved as they arrived. */
	readonly lines: readonly string[];
	readonly reports: readonly Report[];
	/** `<label>: <line>` for every line that matched a fatal pattern. */
	readonly fatal: readonly string[];
	/** How the launched process itself ended; null if it never started. */
	readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
	/** The launched process was still running when the deadline passed. */
	readonly aliveAtDeadline: boolean;
	/** The deadline passed before the output closed. */
	readonly stoppedAtDeadline: boolean;
	readonly spawnError: string | null;
}

export interface SuperviseDeps {
	readonly spawn: (
		command: string,
		args: readonly string[],
		options: {
			cwd?: string;
			env: NodeJS.ProcessEnv;
			detached: true;
			stdio: ['ignore', 'pipe', 'pipe'];
		}
	) => ChildProcess;
	/** Signal a whole process group; false when it no longer exists. */
	readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => boolean;
	/** Where each line is echoed as it arrives. */
	readonly echo: (line: string) => void;
}

const DEFAULT_GRACE_MS = 5_000;

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch {
		return false;
	}
}

export const defaultDeps: SuperviseDeps = {
	spawn: (command, args, options) => nodeSpawn(command, [...args], options),
	signalGroup,
	echo: (line) => process.stdout.write(`  | ${line}\n`),
};

function onLines(stream: NodeJS.ReadableStream | null, handle: (line: string) => void) {
	if (!stream) return;
	let buffer = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) handle(line);
	});
	stream.on('end', () => {
		if (buffer) handle(buffer);
		buffer = '';
	});
}

export function runApp(spec: LaunchSpec, deps: SuperviseDeps = defaultDeps): Promise<RunResult> {
	const lines: string[] = [];
	const reports: Report[] = [];
	const fatal: string[] = [];
	const handle = (raw: string) => {
		const line = raw.replace(/\r$/, '');
		lines.push(line);
		deps.echo(line);
		const report = parseReport(line);
		if (report) reports.push(report);
		const label = fatalMatch(line);
		if (label) fatal.push(`${label}: ${line}`);
	};

	return new Promise((resolve) => {
		let exit: RunResult['exit'] = null;
		let aliveAtDeadline = false;
		let stoppedAtDeadline = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const child = deps.spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const pgid = child.pid;

		const finish = (spawnError: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			if (killTimer) clearTimeout(killTimer);
			if (pgid !== undefined) deps.signalGroup(pgid, 'SIGKILL');
			resolve({ lines, reports, fatal, exit, aliveAtDeadline, stoppedAtDeadline, spawnError });
		};

		const deadline = setTimeout(() => {
			stoppedAtDeadline = true;
			aliveAtDeadline = exit === null;
			if (pgid === undefined) return;
			deps.signalGroup(pgid, 'SIGTERM');
			killTimer = setTimeout(
				() => deps.signalGroup(pgid, 'SIGKILL'),
				spec.graceMs ?? DEFAULT_GRACE_MS
			);
		}, spec.deadlineMs);

		onLines(child.stdout, handle);
		onLines(child.stderr, handle);
		child.once('exit', (code, signal) => {
			exit = { code, signal };
		});
		child.once('close', () => finish(null));
		child.once('error', (error) => finish(error.message));
	});
}
