/**
 * Authentication and state preconditions shared across IMAP command
 * modules.
 *
 *   - `checkRequires` enforces a module's declared `requires` (logged in,
 *     a folder selected, the selected folder writable). The walker calls
 *     it for every module before `start`, and the UID dispatcher calls it
 *     for UID sub-commands, so modules no longer open-code the preamble.
 *     It is pure: it returns the line to send, or null when the command
 *     may run.
 *   - `authenticateAppPassword` is the credential check behind LOGIN and
 *     AUTHENTICATE PLAIN: throttle and tarpit, verify, touch, commit the
 *     new auth state. The two modules keep their own framing (TLS refusal,
 *     SASL continuation) and their tagged OK / NO lines.
 */

import { sleep } from '@owlat/shared';
import { IMAP_WIRE_VERSION } from '@owlat/shared/imapWire';
import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import type { CommandRequirement, ConnectionState, StartArgs } from '../types.js';

/** Returns null when authenticated; otherwise a BAD line to emit. */
function requireAuth(state: ConnectionState, tag: string): string | null {
	if (state.auth) return null;
	return `${tag} BAD Not authenticated`;
}

/** Returns null when a folder is SELECTed; otherwise a BAD line to emit. */
function requireSelect(state: ConnectionState, tag: string): string | null {
	if (state.selected) return null;
	return `${tag} BAD No mailbox selected`;
}

/**
 * Returns null when the SELECTed folder is writable; otherwise a NO
 * line to emit. Runs after `requireSelect` so the selection is known
 * to exist.
 */
function requireWritableSelect(state: ConnectionState, tag: string): string | null {
	if (state.selected?.readOnly) {
		return `${tag} NO Mailbox is read-only`;
	}
	return null;
}

/**
 * Check a module's declared precondition. Returns null when the command
 * may run, otherwise the reply to send. The checks run in order: auth,
 * then selection, then writability, so an unauthenticated client always
 * sees `BAD Not authenticated` first.
 */
export function checkRequires(
	requires: CommandRequirement | undefined,
	state: ConnectionState,
	tag: string
): string | null {
	if (requires === undefined) return null;
	const authFail = requireAuth(state, tag);
	if (authFail || requires === 'auth') return authFail;
	const selectFail = requireSelect(state, tag);
	if (selectFail || requires === 'selected') return selectFail;
	return requireWritableSelect(state, tag);
}

/**
 * Cap the tarpit at 5s so a sustained attacker doesn't burn file
 * descriptors. Redis still remembers the full window across reconnects.
 */
const TARPIT_SLEEP_CAP_MS = 5_000;

type AuthenticateContext = Pick<StartArgs<unknown>, 'deps' | 'state' | 'send' | 'verb'>;

/**
 * Verify an app password for LOGIN or AUTHENTICATE and, on success,
 * commit the authenticated state and send the untagged
 * `* OK [CAPABILITY …] Authenticated` banner. Returns 'failed' when the
 * caller must answer `NO Authentication failed`: the client is
 * throttled (after the tarpit), the password is wrong, or the backend
 * threw. Every failure is recorded against the rate limiter.
 *
 * `address` must already be lower-cased; it is the rate-limit key and
 * the address sent to the backend.
 */
export async function authenticateAppPassword(
	ctx: AuthenticateContext,
	address: string,
	password: string
): Promise<'ok' | 'failed'> {
	const { deps, state, send, verb } = ctx;

	const limit = await deps.rateLimiter.check(deps.remoteIp, address);
	if (limit.throttled) {
		logger.warn(
			{
				ip: deps.remoteIp,
				user: address,
				authCount: limit.authCount,
				ipCount: limit.ipCount,
			},
			`${verb} throttled — tarpitting`
		);
		await sleep(Math.min(limit.tarpitMs, TARPIT_SLEEP_CAP_MS));
		await deps.rateLimiter.recordFailure(deps.remoteIp, address);
		return 'failed';
	}

	try {
		// The peer IP lets Convex apply its per-IP failure budget to this client,
		// under the same policy that throttles SMTP submission.
		const result = await deps.convex.action(fn.verifyAppPassword, {
			address,
			password,
			scope: 'imap',
			ip: deps.remoteIp,
		});

		if (!result) {
			logger.warn({ ip: deps.remoteIp, user: address }, `${verb} failed`);
			await deps.rateLimiter.recordFailure(deps.remoteIp, address);
			return 'failed';
		}

		// Best-effort touch — don't block the OK response on it. The
		// userAgent comes from a prior RFC 2971 ID command (if the client
		// sent one); it surfaces in the app-passwords admin UI as the
		// "Last used" device/client.
		deps.convex
			.mutation(fn.touchAppPassword, {
				appPasswordId: result.appPasswordId,
				ip: deps.remoteIp,
				...(state.clientId ? { userAgent: state.clientId } : {}),
				// Tells the backend this login did not come through an IMAP server
				// too old to report its version (ADR-0063).
				imapWireVersion: IMAP_WIRE_VERSION,
			})
			.catch(() => undefined);

		deps.commit({
			...state,
			auth: {
				mailboxId: result.mailboxId,
				appPasswordId: result.appPasswordId,
				userId: result.userId,
				address,
			},
		});
		send(`* OK [${deps.capabilityLine}] Authenticated`);
		return 'ok';
	} catch (err) {
		logger.error({ err }, `${verb} error`);
		await deps.rateLimiter.recordFailure(deps.remoteIp, address);
		return 'failed';
	}
}
