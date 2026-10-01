/**
 * The pump's outbound side: framing a response onto the socket and pacing
 * bulk writers against the socket's queue (issue #926). Split out of
 * `connection.ts`, which owns the socket lifecycle and the inbound side.
 */

import type { Socket } from 'net';
import type { TLSSocket } from 'tls';

const CRLF = Buffer.from('\r\n');

/**
 * Output a bulk writer (FETCH) may leave queued on the socket before it waits
 * for `drain`. Well above the stream's own 16 KiB high-water mark so a fast
 * reader is not stalled every few messages, and small enough that a slow one
 * holds this plus one response per connection, not the mailbox.
 */
export const OUTPUT_BUDGET_BYTES = 1024 * 1024;

/**
 * Write one response line plus its CRLF. A Buffer is written as raw octets
 * so a FETCH body literal keeps the exact 8-bit/binary bytes of the stored
 * message; its CRLF goes as a second write, not a concat that would copy the
 * whole (possibly multi-MiB) response once more, and corking hands both to
 * the kernel in one writev (`cork` is absent on test mocks). Strings take the
 * UTF-8 text path.
 */
export function writeLine(socket: Socket | TLSSocket, line: string | Buffer): void {
	if (Buffer.isBuffer(line)) {
		socket.cork?.();
		socket.write(line);
		socket.write(CRLF);
		socket.uncork?.();
		return;
	}
	socket.write(`${line}\r\n`);
}

/**
 * Build the connection's `CommandDeps.waitForDrain`. The returned function
 * gives `undefined` while the socket's queue is within
 * {@link OUTPUT_BUDGET_BYTES} (or the connection is going away); otherwise a
 * promise that resolves on `drain`, `close` or `error`, whichever comes first,
 * so a wait can never be stranded by a peer that disconnects instead of
 * reading. Concurrent waiters share one promise, so waiting adds no listeners
 * per response.
 */
export function drainWaiter(
	socket: Socket | TLSSocket,
	isClosed: () => boolean
): () => Promise<void> | undefined {
	let pending: Promise<void> | null = null;
	return () => {
		if (
			isClosed() ||
			socket.destroyed ||
			!socket.writableNeedDrain ||
			socket.writableLength <= OUTPUT_BUDGET_BYTES
		) {
			return undefined;
		}
		pending ??= new Promise<void>((resolve) => {
			const done = (): void => {
				socket.off('drain', done);
				socket.off('close', done);
				socket.off('error', done);
				pending = null;
				resolve();
			};
			socket.on('drain', done);
			socket.on('close', done);
			socket.on('error', done);
		});
		return pending;
	};
}
