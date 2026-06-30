import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

export const logoutModule: ImapCommandModule<void> = {
	verbs: ['LOGOUT'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start({ deps, tag, send }) {
		send('* BYE Owlat IMAP signing off');
		send(`${tag} OK LOGOUT completed`);
		deps.closeConnection();
		return syncSession();
	},
};
