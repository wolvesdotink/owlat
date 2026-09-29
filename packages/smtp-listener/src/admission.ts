/**
 * Connection admission: the global live-connection cap and the optional per-IP
 * slot limiter from {@link SmtpAdmission}, applied in the listener's own accept
 * path.
 *
 * Every accepted socket is counted synchronously, at accept, before any caller
 * hook runs, so the capacity decision always includes the connection under
 * decision (smtp-server's `connections.size > maxClients`).
 *
 * SLOT RECONCILIATION. `perIp.acquire` is async, so a connection can close
 * (client RST: port scans and load-balancer probes do exactly this) while its
 * acquire is still in flight. Each socket carries its own two flags, `closed`
 * and `held`, and the two possible orderings each release exactly once:
 *
 *   - acquire grants, then the socket closes: `held` is set, and the close
 *     handler releases.
 *   - the socket closes, then acquire grants: the close handler found nothing
 *     held, so the grant releases immediately instead of marking.
 *
 * A refused acquire took no slot and a failed one fails open without one, so
 * neither ever releases. Release failures are swallowed: the limiter's own
 * expiry is the backstop for a lost release.
 */

import type { Socket } from 'node:net';
import type { Server as TlsServer } from 'node:tls';
import type { SmtpAdmission, SmtpAdmissionPeer, SmtpReply } from './types.js';

/**
 * How long an implicit-TLS socket may wait for its admission verdict before it
 * is destroyed. The handshake has not started, so nothing else bounds it; this
 * matches the submission listener's 30 s handshake window.
 */
const IMPLICIT_TLS_ADMISSION_DEADLINE_MS = 30_000;

/** Decides admission for accepted sockets. */
interface AdmissionGate {
	/**
	 * Count `socket` and decide whether it may proceed. Resolves to the refusal
	 * reply, or `undefined` to admit. Never rejects.
	 */
	admit(socket: Socket): Promise<SmtpReply | undefined>;
}

export function createAdmissionGate(
	admission: SmtpAdmission,
	onError: ((err: Error) => void) | undefined
): AdmissionGate {
	let live = 0;
	return {
		admit(socket: Socket): Promise<SmtpReply | undefined> {
			live += 1;
			const peer: SmtpAdmissionPeer = {
				remoteAddress: socket.remoteAddress ?? '',
				remotePort: socket.remotePort ?? 0,
			};
			const perIp = admission.perIp;
			let closed = false;
			let held = false;
			const release = (): void => {
				perIp?.release(peer).catch(() => {
					// Non-critical: the limiter's expiry reclaims a lost release.
				});
			};
			socket.once('close', () => {
				live -= 1;
				closed = true;
				if (held) {
					held = false;
					release();
				}
			});

			if (live > admission.maxClients) {
				admission.onRefused?.(peer, 'capacity');
				return Promise.resolve(admission.overCapacityReply);
			}
			if (!perIp) return Promise.resolve(undefined);

			let acquiring: Promise<boolean>;
			try {
				acquiring = perIp.acquire(peer);
			} catch (err) {
				acquiring = Promise.reject(err);
			}
			return acquiring.then(
				(granted) => {
					if (!granted) {
						admission.onRefused?.(peer, 'perIp');
						return perIp.rejectReply;
					}
					if (closed) release();
					else held = true;
					return undefined;
				},
				(err: unknown) => {
					// Fail open: a limiter fault must not lock out legitimate peers.
					onError?.(err instanceof Error ? err : new Error(String(err)));
					return undefined;
				}
			);
		},
	};
}

/**
 * Admit implicit-TLS connections BEFORE their handshake.
 *
 * `tls.Server` registers its own `'connection'` handler at construction, and
 * that handler wraps the socket and starts the handshake at once, even on a
 * paused socket. Admitting only after the handshake would let a silent peer
 * hold a connection without ever touching the per-IP limiter. So the TLS
 * handlers are detached here and replayed only for admitted sockets; refused
 * ones are destroyed, since no reply is possible before TLS. `track` lets the
 * listener's `close()` reach sockets still waiting for a verdict.
 */
export function admitBeforeHandshake(
	server: TlsServer,
	gate: AdmissionGate,
	track: (socket: Socket) => void,
	deadlineMs = IMPLICIT_TLS_ADMISSION_DEADLINE_MS
): void {
	const tlsAccept = server.listeners('connection') as Array<(socket: Socket) => void>;
	server.removeAllListeners('connection');
	server.on('connection', (socket: Socket) => {
		track(socket);
		socket.pause();
		const deadline = setTimeout(() => socket.destroy(), deadlineMs);
		socket.once('close', () => clearTimeout(deadline));
		void gate.admit(socket).then((refusal) => {
			clearTimeout(deadline);
			if (refusal) {
				socket.destroy();
				return;
			}
			if (socket.destroyed) return;
			for (const accept of tlsAccept) accept.call(server, socket);
		});
	});
}
