import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth } from '../helpers/auth.js';
import { resolveFolderByName } from '../helpers/folders.js';
import { parseList } from '../../parser.js';
import { logger } from '../../logger.js';

interface StatusArgs {
	readonly mailboxName: string;
	readonly itemsToken: string;
}

export const statusModule: ImapCommandModule<StatusArgs> = {
	verbs: ['STATUS'],
	parseArgs(rawArgs) {
		const [mailboxName, itemsToken] = rawArgs;
		if (!mailboxName || !itemsToken) {
			return { ok: false, error: 'STATUS requires <mailbox> (items)' };
		}
		return { ok: true, args: { mailboxName, itemsToken } };
	},
	start({ deps, state, args, tag, send }) {
		const fail = requireAuth(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		return asyncSession(async () => {
			try {
				const target = await resolveFolderByName(
					deps.convex,
					state.auth!.mailboxId,
					args.mailboxName
				);

				if (!target) {
					send(`${tag} NO Mailbox not found`);
					return;
				}

				const items = parseList(args.itemsToken).map((s) => s.toUpperCase());
				const out: string[] = [];
				for (const item of items) {
					switch (item) {
						case 'MESSAGES':
							out.push(`MESSAGES ${target.totalCount ?? 0}`);
							break;
						case 'UIDNEXT':
							out.push(`UIDNEXT ${target.uidNext ?? 1}`);
							break;
						case 'UIDVALIDITY':
							// Must report the folder's persisted uidValidity (RFC 3501
							// §2.3.1.1) — the same value SELECT returns in
							// `[UIDVALIDITY n]`. Emitting uidNext here (which changes on
							// every new message) made clients see UIDVALIDITY change on
							// every poll and wipe their UID caches.
							out.push(`UIDVALIDITY ${target.uidValidity ?? 1}`);
							break;
						case 'UNSEEN':
							out.push(`UNSEEN ${target.unseenCount ?? 0}`);
							break;
						case 'HIGHESTMODSEQ':
							out.push(`HIGHESTMODSEQ ${target.highestModseq ?? 0}`);
							break;
						case 'RECENT':
							out.push('RECENT 0');
							break;
					}
				}

				send(`* STATUS "${target.name}" (${out.join(' ')})`);
				send(`${tag} OK STATUS completed`);
			} catch (err) {
				logger.error({ err }, 'STATUS failed');
				send(`${tag} BAD STATUS failed`);
			}
		});
	},
};
