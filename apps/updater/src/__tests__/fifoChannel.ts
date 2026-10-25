import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, rmSync, writeSync } from 'node:fs';
import net from 'node:net';

/**
 * Named pipes between a test and the shell fixtures it starts, so the test
 * awaits what a fixture reports instead of polling a file for it.
 *
 * The test opens each pipe read-write. Opening a FIFO for one direction only
 * blocks until its other end is opened; read-write never blocks. And since
 * the test always holds a writer, the pipe never reports end-of-file between
 * fixtures, and a line written while no one is reading waits in the pipe.
 */

function makeFifo(path: string): void {
	rmSync(path, { force: true });
	execFileSync('mkfifo', [path]);
}

/**
 * Lines a fixture writes into `path` (`echo $$ > path`), in order. `next()`
 * resolves with the next line, at once if one already arrived.
 */
export function fifoLines(path: string): { next(): Promise<string>; close(): void } {
	makeFifo(path);
	const socket = new net.Socket({
		fd: openSync(path, constants.O_RDWR | constants.O_NONBLOCK),
		readable: true,
		writable: false,
	});
	const lines: string[] = [];
	const waiters: Array<(line: string) => void> = [];
	let partial = '';
	socket.on('data', (chunk: Buffer) => {
		partial += chunk.toString('utf8');
		const complete = partial.split('\n');
		partial = complete.pop()!;
		for (const line of complete) {
			const waiter = waiters.shift();
			if (waiter) waiter(line);
			else lines.push(line);
		}
	});
	return {
		next() {
			const line = lines.shift();
			if (line !== undefined) return Promise.resolve(line);
			return new Promise<string>((resolve) => waiters.push(resolve));
		},
		close() {
			socket.destroy();
		},
	};
}

/**
 * A gate a fixture blocks on (`read line < path`) until the test releases it.
 * A release written before the fixture reaches the gate is kept for it; each
 * release lets exactly one `read` through.
 */
export function fifoGate(path: string): { release(): void; close(): void } {
	makeFifo(path);
	let fd: number | undefined = openSync(path, constants.O_RDWR);
	return {
		release() {
			if (fd !== undefined) writeSync(fd, '\n');
		},
		close() {
			if (fd === undefined) return;
			closeSync(fd);
			fd = undefined;
		},
	};
}
