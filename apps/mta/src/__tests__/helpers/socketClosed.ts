/**
 * Await a socket's `'close'` while tolerating the reset that may precede it.
 *
 * A peer that tears a connection down can reset it, and node then emits
 * `'error'` (ECONNRESET, or EPIPE for a write racing the teardown) before
 * `'close'`. `events.once(socket, 'close')` rejects on that first `'error'`
 * even though `'close'` follows, so a test asserting "the connection was
 * dropped" would fail on exactly the outcome it expects. Any other socket
 * error still rejects. A socket that never closes leaves the promise pending,
 * and the test fails on the runner's budget.
 */

import type { Socket } from 'node:net';

const RESET_CODES = new Set(['ECONNRESET', 'EPIPE']);

export function socketClosed(socket: Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		let unexpected: Error | undefined;
		const onError = (err: NodeJS.ErrnoException): void => {
			if (!RESET_CODES.has(err.code ?? '')) unexpected ??= err;
		};
		socket.on('error', onError);
		const settle = (): void => {
			socket.off('error', onError);
			if (unexpected) reject(unexpected);
			else resolve();
		};
		if (socket.closed) settle();
		else socket.once('close', settle);
	});
}
