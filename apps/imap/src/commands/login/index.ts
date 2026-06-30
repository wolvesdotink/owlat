import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { sleep } from '../../rateLimit.js';
import { fn } from '../../convex.js';
import { logger } from '../../logger.js';

interface LoginArgs {
	readonly user: string;
	readonly password: string;
}

/**
 * Cap the tarpit at 5s so a sustained attacker doesn't burn file
 * descriptors. Redis still remembers the full window across reconnects.
 */
const TARPIT_SLEEP_CAP_MS = 5_000;

interface VerifyAppPasswordResult {
	readonly mailboxId: string;
	readonly appPasswordId: string;
	readonly userId: string;
	readonly organizationId: string;
}

export const loginModule: ImapCommandModule<LoginArgs> = {
	verbs: ['LOGIN'],
	parseArgs(rawArgs) {
		const [user, password] = rawArgs;
		if (!user || !password) {
			return { ok: false, error: 'LOGIN requires <user> <password>' };
		}
		return { ok: true, args: { user, password } };
	},
	start({ deps, state, args, tag, send }) {
		if (state.auth) {
			send(`${tag} BAD Already authenticated`);
			return syncSession();
		}

		// Never transport credentials in the clear (RFC 3501 §11.1, RFC
		// 2595). On the dev plaintext fallback the capability line carries
		// LOGINDISABLED, so a conformant client never sends LOGIN; refuse it
		// here too — and crucially do NOT call convex.verify.
		if (!deps.tls) {
			send(`${tag} NO [PRIVACYREQUIRED] LOGIN requires TLS`);
			return syncSession();
		}

		return asyncSession(async (): Promise<void> => {
			const address = args.user.toLowerCase();

			const limit = await deps.rateLimiter.check(deps.remoteIp, address);
			if (limit.throttled) {
				logger.warn(
					{
						ip: deps.remoteIp,
						user: args.user,
						authCount: limit.authCount,
						ipCount: limit.ipCount,
					},
					'LOGIN throttled — tarpitting',
				);
				await sleep(Math.min(limit.tarpitMs, TARPIT_SLEEP_CAP_MS));
				await deps.rateLimiter.recordFailure(deps.remoteIp, address);
				send(`${tag} NO Authentication failed`);
				return;
			}

			try {
				const result = (await deps.convex.action(fn.verifyAppPassword as never, {
					address,
					password: args.password,
					scope: 'imap',
				} as never)) as VerifyAppPasswordResult | null;

				if (!result) {
					logger.warn({ ip: deps.remoteIp, user: args.user }, 'LOGIN failed');
					await deps.rateLimiter.recordFailure(deps.remoteIp, address);
					send(`${tag} NO Authentication failed`);
					return;
				}

				// Best-effort touch — don't block the OK response on it. The
				// userAgent comes from a prior RFC 2971 ID command (if the
				// client sent one); it surfaces in the app-passwords admin UI
				// as the "Last used" device/client.
				deps.convex
					.mutation(fn.touchAppPassword as never, {
						appPasswordId: result.appPasswordId,
						ip: deps.remoteIp,
						...(state.clientId ? { userAgent: state.clientId } : {}),
					} as never)
					.catch(() => undefined);

				deps.commit({
					...state,
					auth: {
						mailboxId: result.mailboxId,
						appPasswordId: result.appPasswordId,
						userId: result.userId,
						address,
					},
					selected: state.selected,
				});
				send(`* OK [${deps.capabilityLine}] Authenticated`);
				send(`${tag} OK LOGIN completed`);
			} catch (err) {
				logger.error({ err }, 'LOGIN error');
				await deps.rateLimiter.recordFailure(deps.remoteIp, address);
				send(`${tag} NO Authentication failed`);
			}
		});
	},
};
