import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth } from '../helpers/auth.js';
import { listFolders } from '../helpers/folders.js';
import { flagsForFolder } from '../helpers/folderFlags.js';
import { logger } from '../../logger.js';

interface ListArgs {
	readonly reference: string;
	readonly pattern: string;
}

/**
 * LIST and LSUB share one module. LSUB filters to `subscribed: true`
 * folders only; LIST returns all. The verb arrives in `start({ verb })`
 * so the response label and filter both branch off it.
 */
export const listModule: ImapCommandModule<ListArgs> = {
	verbs: ['LIST', 'LSUB'],
	capabilities: ['LIST-EXTENDED', 'LIST-STATUS', 'SPECIAL-USE'],
	parseArgs(rawArgs) {
		return {
			ok: true,
			args: {
				reference: rawArgs[0] ?? '',
				pattern: rawArgs[1] ?? '*',
			},
		};
	},
	start({ deps, state, tag, verb, send }) {
		const fail = requireAuth(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		return asyncSession(async () => {
			try {
				const folders = await listFolders(deps.convex, state.auth!.mailboxId);
				for (const f of folders) {
					if (verb === 'LSUB' && !f.subscribed) continue;
					const flags = flagsForFolder(f.role);
					const quoted = `"${f.name.replace(/"/g, '\\"')}"`;
					send(`* ${verb} (${flags}) "/" ${quoted}`);
				}
				send(`${tag} OK ${verb} completed`);
			} catch (err) {
				logger.error({ err }, 'LIST failed');
				send(`${tag} BAD ${verb} failed`);
			}
		});
	},
};
