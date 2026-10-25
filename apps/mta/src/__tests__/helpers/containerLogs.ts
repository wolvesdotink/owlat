import { spawn } from 'node:child_process';

/**
 * Resolves once the named container has written a log line matching
 * `pattern`, read from `docker logs --follow`. The stream replays the log from
 * the container's start, so a line written before this was called still
 * counts. Rejects when the stream ends first: the container exited (its
 * `--rm` removed it) or never existed.
 *
 * Readiness comes from what the owned container says about itself, not from
 * probing it on a timer: a probe that is retried until it answers passes or
 * fails with machine speed.
 */
export function containerLogLine(name: string, pattern: RegExp): Promise<void> {
	return new Promise((resolve, reject) => {
		const logs = spawn('docker', ['logs', '--follow', name], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let tail = '';
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			logs.kill();
			if (error) reject(error);
			else resolve();
		};
		const read = (chunk: Buffer) => {
			// Keep enough to match a line split across chunks.
			tail = (tail + chunk.toString('utf8')).slice(-8_192);
			if (pattern.test(tail)) finish();
		};
		logs.stdout.on('data', read);
		logs.stderr.on('data', read);
		logs.on('error', finish);
		logs.on('close', () =>
			finish(new Error(`container ${name} stopped before logging ${pattern}:\n${tail}`))
		);
	});
}
