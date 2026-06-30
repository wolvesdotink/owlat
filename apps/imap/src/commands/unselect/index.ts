import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

/**
 * UNSELECT (RFC 3691) and CLOSE share the same effect for this server —
 * both deselect the current mailbox. CLOSE in IMAP4rev1 also expunges
 * `\Deleted` messages, but Owlat doesn't auto-expunge; clients use
 * EXPUNGE explicitly.
 *
 * Neither command requires authentication — the existing handler tests
 * exercise UNSELECT-before-LOGIN as a happy path (no crash).
 */
export const unselectModule: ImapCommandModule<void> = {
	verbs: ['UNSELECT', 'CLOSE'],
	capabilities: ['UNSELECT'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start({ deps, state, tag, verb, send }) {
		deps.commit({ ...state, selected: null });
		send(`${tag} OK ${verb} completed`);
		return syncSession();
	},
};
