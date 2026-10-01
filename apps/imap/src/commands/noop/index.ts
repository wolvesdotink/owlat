import type { CommandSession, ImapCommandModule, StartArgs } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { syncSequenceView } from '../helpers/sequenceView.js';
import { logger } from '../../logger.js';

/**
 * Complete a command that only asks for news. With a folder SELECTed it first
 * announces what other sessions changed since the client last heard
 * (`* n EXPUNGE`, `* n EXISTS`; RFC 3501 §6.1.2, §7.4.1). A failed look is
 * logged and the command still completes: nothing was asked of it, and the
 * news waits for the next one.
 */
export function reportNews({ deps, state, tag, verb, send }: StartArgs<void>): CommandSession {
	if (!state.selected?.view) {
		send(`${tag} OK ${verb} completed`);
		return syncSession();
	}
	return asyncSession(async (signal) => {
		try {
			await syncSequenceView(deps, state, send, signal);
		} catch (err) {
			logger.warn({ err }, `${verb} could not read the folder`);
		}
		send(`${tag} OK ${verb} completed`);
	});
}

export const noopModule: ImapCommandModule<void> = {
	verbs: ['NOOP'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start: reportNews,
};
