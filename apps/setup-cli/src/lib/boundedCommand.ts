/**
 * Run a command with a byte cap on its captured output and a kill deadline,
 * for collectors that read whatever an unhealthy system prints: a crash-looping
 * container can log megabytes per second, and a hung Docker daemon never
 * answers. Output past the cap is dropped from the end the caller does not need.
 */

import { spawn } from 'node:child_process';

export interface CommandResult {
	/** Exit code; 127 when the program could not be started. */
	code: number;
	output: string;
	/** Output beyond the byte cap was dropped. */
	truncated: boolean;
	timedOut: boolean;
}

export interface CommandOptions {
	cwd: string;
	timeoutMs: number;
	maxBytes: number;
	/** Which end to keep when the output is over `maxBytes`. */
	keep: 'head' | 'tail';
	/** Capture stderr into `output` too (container logs come on both streams). */
	mergeStderr?: boolean;
}

/** Run `command`, keeping at most `maxBytes` of its output and killing it after `timeoutMs`. */
export function runBounded(
	command: string,
	args: readonly string[],
	options: CommandOptions
): Promise<CommandResult> {
	return new Promise((done) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let timedOut = false;
		const take = (chunk: Buffer) => {
			if (options.keep === 'head') {
				const room = options.maxBytes - size;
				if (room <= 0) {
					truncated = true;
					return;
				}
				if (chunk.length > room) truncated = true;
				const kept = chunk.subarray(0, room);
				chunks.push(kept);
				size += kept.length;
				return;
			}
			chunks.push(chunk);
			size += chunk.length;
			while (size > options.maxBytes && chunks.length > 0) {
				truncated = true;
				const first = chunks[0]!;
				const excess = size - options.maxBytes;
				if (first.length <= excess) {
					chunks.shift();
					size -= first.length;
				} else {
					chunks[0] = first.subarray(excess);
					size -= excess;
				}
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			// Its own process group, so the deadline reaches what the command starts
			// too: `docker compose` runs as a CLI plugin process that inherits the
			// output pipes and outlives a killed `docker`.
			child = spawn(command, [...args], {
				cwd: options.cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true,
			});
		} catch {
			done({ code: 127, output: '', truncated: false, timedOut: false });
			return;
		}
		const killGroup = () => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// The group is already gone.
			}
		};
		let exitCode: number | null = null;
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			let output = Buffer.concat(chunks).toString('utf8');
			// A tail cut lands mid-line; drop the partial first line.
			if (truncated && options.keep === 'tail') output = output.slice(output.indexOf('\n') + 1);
			done({ code, output, truncated, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = exitCode === null;
			killGroup();
			// A process that left the group (setsid) can still hold the pipes; the
			// deadline bounds the wait for them as well.
			child.stdout?.destroy();
			child.stderr?.destroy();
			finish(exitCode ?? 137);
		}, options.timeoutMs);
		child.stdout?.on('data', take);
		if (options.mergeStderr) child.stderr?.on('data', take);
		else child.stderr?.resume();
		child.on('error', () => finish(127));
		child.on('exit', (code) => {
			exitCode = code ?? 1;
			// A descendant left behind keeps the pipes open, and `close` waits for them.
			killGroup();
		});
		child.on('close', (code) => finish(exitCode ?? code ?? 1));
	});
}
