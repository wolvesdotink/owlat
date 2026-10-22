/**
 * Runs the stack's long-lived processes in the foreground with prefixed
 * output, and stops all of them together: on Ctrl-C, on SIGTERM, or when any
 * one of them exits. Each child gets its own process group so the signal also
 * reaches what it spawned (Nuxt's workers, esbuild), and nothing outside the
 * groups started here is touched.
 */

import { spawn } from 'node:child_process';

export interface ChildSpec {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

/** How long a group gets between SIGTERM and SIGKILL. */
const STOP_GRACE_MS = 10_000;
/** How often the groups are checked for leftovers once every leader is gone. */
const GROUP_POLL_MS = 100;
/** How long SIGKILLed groups get to disappear before supervise gives up on them. */
const KILL_SETTLE_MS = 2_000;

function pipeLines(stream: NodeJS.ReadableStream | null, prefix: string, out: NodeJS.WriteStream) {
	if (!stream) return;
	let buffer = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) out.write(`${prefix} ${line}\n`);
	});
	stream.on('end', () => {
		if (buffer) out.write(`${prefix} ${buffer}\n`);
	});
}

/**
 * A group is addressed by its leader's PID, which stays valid after the
 * leader exits for as long as any member is left: the kernel does not hand a
 * PID out again while a process group still uses it. So a launcher that exits
 * early does not take its descendants out of reach.
 */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (error) {
		// EPERM means the group exists but is not ours to signal.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function groupExists(pgid: number): boolean {
	return signalGroup(pgid, 0);
}

interface SuperviseTimings {
	readonly graceMs?: number;
	readonly pollMs?: number;
	readonly killSettleMs?: number;
}

/**
 * Resolves with 0 after a stop requested by a signal, or with the exit code
 * of the child whose exit brought the rest down. `onStop` runs once, first.
 */
export function supervise(
	specs: readonly ChildSpec[],
	onStop: () => void = () => {},
	timings: SuperviseTimings = {}
): Promise<number> {
	const {
		graceMs = STOP_GRACE_MS,
		pollMs = GROUP_POLL_MS,
		killSettleMs = KILL_SETTLE_MS,
	} = timings;
	const width = Math.max(...specs.map((spec) => spec.name.length));
	const children = specs.map((spec) => {
		const child = spawn(spec.command, [...spec.args], {
			cwd: spec.cwd,
			env: spec.env,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const prefix = `[${spec.name.padEnd(width)}]`;
		pipeLines(child.stdout, prefix, process.stdout);
		pipeLines(child.stderr, prefix, process.stderr);
		return { spec, child };
	});

	// Every group started here, kept after its leader exits: a launcher can
	// exit while what it spawned keeps running and holding ports.
	const groups = children.flatMap(({ child }) => (child.pid === undefined ? [] : [child.pid]));

	return new Promise((resolve) => {
		let stopping = false;
		let exitCode = 0;
		let remaining = children.length;
		let killedAt: number | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;

		const signalAll = (signal: NodeJS.Signals) => {
			for (const pgid of groups) signalGroup(pgid, signal);
		};

		const finish = () => {
			if (killTimer) clearTimeout(killTimer);
			if (pollTimer) clearTimeout(pollTimer);
			for (const signal of signals) process.off(signal, onSignal);
			resolve(exitCode);
		};

		// Polls from the start of the stop: a group nobody is left in is dropped
		// at once, so its number is never signalled after the kernel could
		// reuse it. Resolves only when every leader has exited and no group
		// started here has a member left, and keeps the SIGKILL escalation
		// armed until then.
		const poll = () => {
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = undefined;
			for (let i = groups.length - 1; i >= 0; i -= 1) {
				if (!groupExists(groups[i]!)) groups.splice(i, 1);
			}
			if (remaining === 0 && groups.length === 0) return finish();
			if (remaining === 0 && killedAt !== undefined && Date.now() - killedAt >= killSettleMs) {
				process.stderr.write(
					`[dev:stack] process groups ${groups.join(', ')} did not exit after SIGKILL\n`
				);
				return finish();
			}
			pollTimer = setTimeout(poll, pollMs);
		};

		const stopAll = (reason: string) => {
			if (stopping) return;
			stopping = true;
			process.stderr.write(`\n[dev:stack] stopping (${reason})...\n`);
			onStop();
			signalAll('SIGTERM');
			killTimer = setTimeout(() => {
				killedAt = Date.now();
				signalAll('SIGKILL');
			}, graceMs);
			poll();
		};

		const onSignal = (signal: NodeJS.Signals) => stopAll(signal);
		const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
		for (const signal of signals) process.on(signal, onSignal);

		for (const { spec, child } of children) {
			let settled = false;
			const settle = (code: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				if (!stopping) {
					exitCode = code === 0 ? 1 : (code ?? 1);
					stopAll(`${spec.name} exited with ${signal ?? `code ${code}`}`);
				}
				remaining -= 1;
				if (remaining === 0) poll();
			};
			child.once('exit', settle);
			child.once('error', (error) => {
				process.stderr.write(`[dev:stack] could not start ${spec.name}: ${error.message}\n`);
				settle(1, null);
			});
		}
	});
}
