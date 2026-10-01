import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/**
 * One command's scripted answer: its stdout, or a throw carrying `stdout` /
 * `stderr` for a non-zero exit (the shape these tests have always scripted
 * Docker in). A promise is a command that takes its time: the child runs until
 * it settles, or until it is killed.
 */
export type ScriptedCommand = (
	file: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv }
) => string | undefined | Promise<string | undefined>;

interface Failure {
	stdout?: string | Buffer | null;
	stderr?: string | Buffer | null;
}

/**
 * A `spawn` for `vi.mock('node:child_process')` that answers from `command`.
 *
 * The script is called at spawn time, so the mock's call list reads in the
 * order the updater started its commands. The child has no pid, so `exec`
 * signals it through `kill`, which ends it with that signal.
 */
export function spawnFrom(command: ScriptedCommand) {
	return (
		file: string,
		args: string[],
		options: { cwd?: string; env?: NodeJS.ProcessEnv }
	): ChildProcess => {
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		const child = Object.assign(new EventEmitter(), {
			pid: undefined,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			stdout,
			stderr,
			kill: (signal: NodeJS.Signals = 'SIGTERM') => {
				finish(null, signal);
				return true;
			},
		});

		let done = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null, failure?: Failure) => {
			if (done) return;
			done = true;
			setImmediate(() => {
				if (failure?.stdout) stdout.emit('data', Buffer.from(failure.stdout));
				if (failure?.stderr) stderr.emit('data', Buffer.from(failure.stderr));
				child.exitCode = code;
				child.signalCode = signal;
				child.emit('exit', code, signal);
				child.emit('close', code, signal);
			});
		};
		const succeed = (out: string | undefined) => finish(0, null, { stdout: out ?? '' });
		const fail = (err: unknown) => {
			const failure = (err ?? {}) as Failure;
			finish(1, null, {
				stdout: failure.stdout ?? '',
				stderr: failure.stderr ?? (err instanceof Error ? err.message : String(err)),
			});
		};

		try {
			const out = command(file, args, options);
			if (out instanceof Promise) out.then(succeed, fail);
			else succeed(out);
		} catch (err) {
			fail(err);
		}
		return child as unknown as ChildProcess;
	};
}
