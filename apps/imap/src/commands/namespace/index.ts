import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

export const namespaceModule: ImapCommandModule<void> = {
	verbs: ['NAMESPACE'],
	capabilities: ['NAMESPACE'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start({ tag, send }) {
		send('* NAMESPACE (("" "/")) NIL NIL');
		send(`${tag} OK NAMESPACE completed`);
		return syncSession();
	},
};
