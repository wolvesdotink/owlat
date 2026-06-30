import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

export const noopModule: ImapCommandModule<void> = {
	verbs: ['NOOP'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start({ tag, send }) {
		send(`${tag} OK NOOP completed`);
		return syncSession();
	},
};
