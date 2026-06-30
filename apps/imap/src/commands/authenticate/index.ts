/**
 * AUTHENTICATE PLAIN (RFC 3501 §6.2.2, SASL PLAIN per RFC 4616).
 *
 * The server advertises `AUTH=PLAIN` in its CAPABILITY line, so it must
 * honour `AUTHENTICATE PLAIN` — advertising a mechanism the server can't
 * service is an RFC 3501 §7.2.1 / §6.2.2 violation.
 *
 * Flow:
 *   C: a1 AUTHENTICATE PLAIN
 *   S: +
 *   C: <base64( authzid "\0" authcid "\0" passwd )>
 *   S: a1 OK AUTHENTICATE completed
 *
 * RFC 4959 SASL-IR (the initial response folded onto the AUTHENTICATE
 * line as a second arg) is also accepted, in which case no continuation
 * is requested.
 *
 * Like LOGIN this carries the user's password in the clear within the
 * SASL exchange, so it is refused with `[PRIVACYREQUIRED]` on a non-TLS
 * (dev plaintext) connection and `AUTH=PLAIN` is dropped from the
 * capability line in that state (RFC 3501 §11.1, RFC 2595).
 */

import type { CommandSession, ImapCommandModule, ConnectionState } from '../types.js';
import { syncSession } from '../helpers/session.js';
import { sleep } from '../../rateLimit.js';
import { fn } from '../../convex.js';
import { logger } from '../../logger.js';

interface AuthenticateArgs {
	/** The SASL mechanism name, upper-cased (e.g. `PLAIN`). */
	readonly mechanism: string;
	/** RFC 4959 initial response (base64), if folded onto the command line. */
	readonly initialResponse: string | null;
}

/** Mirror of LOGIN's tarpit cap so a sustained attacker can't burn fds. */
const TARPIT_SLEEP_CAP_MS = 5_000;

interface VerifyAppPasswordResult {
	readonly mailboxId: string;
	readonly appPasswordId: string;
	readonly userId: string;
	readonly organizationId: string;
}

interface DecodedPlain {
	readonly authcid: string;
	readonly password: string;
}

/**
 * Decode a SASL PLAIN response: `base64( authzid \0 authcid \0 passwd )`
 * (RFC 4616 §2). `authzid` may be empty; `authcid`/`passwd` must be
 * present. Returns null on invalid base64 or a malformed field layout.
 */
function decodePlain(b64: string): DecodedPlain | null {
	const trimmed = b64.trim();
	// Validate strict base64 before decoding — Buffer.from is lax (it
	// silently drops invalid chars), which would mask a malformed response.
	if (trimmed.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
		return null;
	}
	let decoded: string;
	try {
		decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
	} catch {
		return null;
	}
	const parts = decoded.split('\0');
	if (parts.length !== 3) return null;
	const [, authcid, password] = parts;
	if (!authcid || password === undefined || password.length === 0) {
		return null;
	}
	return { authcid, password };
}

export const authenticateModule: ImapCommandModule<AuthenticateArgs> = {
	verbs: ['AUTHENTICATE'],
	// `AUTH=PLAIN` is added to the capability line by the walker only when
	// the connection is TLS-encrypted, so it is intentionally NOT declared
	// here (a module capability would leak onto plaintext connections).
	parseArgs(rawArgs) {
		const [mechanism, initialResponse] = rawArgs;
		if (!mechanism) {
			return { ok: false, error: 'AUTHENTICATE requires a mechanism' };
		}
		return {
			ok: true,
			args: {
				mechanism: mechanism.toUpperCase(),
				initialResponse: initialResponse ?? null,
			},
		};
	},
	start({ deps, state, args, tag, send }) {
		if (state.auth) {
			send(`${tag} BAD Already authenticated`);
			return syncSession();
		}

		if (args.mechanism !== 'PLAIN') {
			send(`${tag} NO [CANNOT] Unsupported SASL mechanism`);
			return syncSession();
		}

		// Refuse credential transport in the clear (RFC 2595): on the dev
		// plaintext fallback the capability line carries LOGINDISABLED and
		// drops AUTH=PLAIN, so a conformant client never reaches here.
		if (!deps.tls) {
			send(`${tag} NO [PRIVACYREQUIRED] AUTHENTICATE requires TLS`);
			return syncSession();
		}

		let resolved = false;
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((r) => {
			resolveCompletion = r;
		});

		const finish = (): void => {
			if (resolved) return;
			resolved = true;
			resolveCompletion();
		};

		const verify = async (response: string): Promise<void> => {
			const decoded = decodePlain(response);
			if (!decoded) {
				send(`${tag} BAD Invalid SASL PLAIN response`);
				finish();
				return;
			}

			const address = decoded.authcid.toLowerCase();
			const limit = await deps.rateLimiter.check(deps.remoteIp, address);
			if (limit.throttled) {
				logger.warn(
					{
						ip: deps.remoteIp,
						user: decoded.authcid,
						authCount: limit.authCount,
						ipCount: limit.ipCount,
					},
					'AUTHENTICATE throttled — tarpitting',
				);
				await sleep(Math.min(limit.tarpitMs, TARPIT_SLEEP_CAP_MS));
				await deps.rateLimiter.recordFailure(deps.remoteIp, address);
				send(`${tag} NO Authentication failed`);
				finish();
				return;
			}

			try {
				const result = (await deps.convex.action(fn.verifyAppPassword as never, {
					address,
					password: decoded.password,
					scope: 'imap',
				} as never)) as VerifyAppPasswordResult | null;

				if (!result) {
					logger.warn({ ip: deps.remoteIp, user: decoded.authcid }, 'AUTHENTICATE failed');
					await deps.rateLimiter.recordFailure(deps.remoteIp, address);
					send(`${tag} NO Authentication failed`);
					finish();
					return;
				}

				// Best-effort touch — mirror LOGIN; don't block the OK on it.
				deps.convex
					.mutation(fn.touchAppPassword as never, {
						appPasswordId: result.appPasswordId,
						ip: deps.remoteIp,
						...(state.clientId ? { userAgent: state.clientId } : {}),
					} as never)
					.catch(() => undefined);

				const next: ConnectionState = {
					...state,
					auth: {
						mailboxId: result.mailboxId,
						appPasswordId: result.appPasswordId,
						userId: result.userId,
						address,
					},
				};
				deps.commit(next);
				send(`* OK [${deps.capabilityLine}] Authenticated`);
				send(`${tag} OK AUTHENTICATE completed`);
				finish();
			} catch (err) {
				logger.error({ err }, 'AUTHENTICATE error');
				await deps.rateLimiter.recordFailure(deps.remoteIp, address);
				send(`${tag} NO Authentication failed`);
				finish();
			}
		};

		// RFC 4959 SASL-IR: the client folded the initial response onto the
		// command line — no continuation round-trip needed.
		if (args.initialResponse !== null) {
			void verify(args.initialResponse);
			return { completion, cancel: finish };
		}

		// Request the SASL response with an empty continuation (RFC 3501
		// §6.2.2: `+` followed by a base64 challenge — empty for PLAIN).
		send('+ ');

		const session: CommandSession = {
			completion,
			onClientLine(line) {
				if (resolved) return 'pass';
				// RFC 3501 §6.1: a bare `*` cancels the authentication exchange.
				if (line.trim() === '*') {
					send(`${tag} BAD AUTHENTICATE cancelled`);
					finish();
					return 'absorbed';
				}
				void verify(line);
				return 'absorbed';
			},
			cancel: finish,
		};
		return session;
	},
};
