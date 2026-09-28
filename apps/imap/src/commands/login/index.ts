import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { authenticateAppPassword } from '../helpers/auth.js';

interface LoginArgs {
	readonly user: string;
	readonly password: string;
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
	start({ deps, state, args, tag, verb, send }) {
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
			const outcome = await authenticateAppPassword(
				{ deps, state, send, verb },
				args.user.toLowerCase(),
				args.password
			);
			send(outcome === 'ok' ? `${tag} OK LOGIN completed` : `${tag} NO Authentication failed`);
		});
	},
};
