/**
 * Runs the stack's long-lived processes in the foreground with prefixed
 * output, and stops all of them together: on Ctrl-C, on SIGTERM, or when any
 * one of them exits. Each child gets its own process group so the signal also
 * reaches what it spawned (Nuxt's workers, esbuild), and nothing outside the
 * groups started here is touched.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface ChildSpec {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

const STOP_GRACE_MS = 10_000;

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

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

/**
 * Resolves with 0 after a stop requested by a signal, or with the exit code
 * of the child whose exit brought the rest down. `onStop` runs once, first.
 */
export function supervise(
	specs: readonly ChildSpec[],
	onStop: () => void = () => {}
): Promise<number> {
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

	return new Promise((resolve) => {
		let stopping = false;
		let exitCode = 0;
		let remaining = children.length;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const stopAll = (reason: string) => {
			if (stopping) return;
			stopping = true;
			process.stderr.write(`\n[dev:stack] stopping (${reason})...\n`);
			onStop();
			for (const { child } of children) signalGroup(child, 'SIGTERM');
			killTimer = setTimeout(() => {
				for (const { child } of children) signalGroup(child, 'SIGKILL');
			}, STOP_GRACE_MS);
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
				if (remaining === 0) {
					if (killTimer) clearTimeout(killTimer);
					for (const signal of signals) process.off(signal, onSignal);
					resolve(exitCode);
				}
			};
			child.once('exit', settle);
			child.once('error', (error) => {
				process.stderr.write(`[dev:stack] could not start ${spec.name}: ${error.message}\n`);
				settle(1, null);
			});
		}
	});
}
