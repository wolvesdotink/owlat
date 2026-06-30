import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

export const capabilityModule: ImapCommandModule<void> = {
	verbs: ['CAPABILITY'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start({ deps, tag, send }) {
		send(`* ${deps.capabilityLine}`);
		send(`${tag} OK CAPABILITY completed`);
		return syncSession();
	},
};
