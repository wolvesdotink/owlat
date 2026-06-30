import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

/**
 * CHECK — RFC 3501 sync barrier. We have no in-memory state to flush;
 * Convex mutations are durable on return. OK always.
 */
export const checkModule: ImapCommandModule<void> = {
	verbs: ['CHECK'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start({ tag, send }) {
		send(`${tag} OK CHECK completed`);
		return syncSession();
	},
};
