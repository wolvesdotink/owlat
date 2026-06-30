import type { ImapCommandModule, ImapVerb } from '../types.js';
import { syncSession } from '../helpers/session.js';
import { fetchModule, type FetchArgs } from '../fetch/index.js';
import { storeModule, type StoreArgs } from '../store/index.js';
import { copyModule, type CopyArgs } from '../copy/index.js';
import { moveModule, type MoveArgs } from '../move/index.js';
import { expungeModule, type ExpungeArgs } from '../expunge/index.js';

type UidSubVerb = 'FETCH' | 'STORE' | 'COPY' | 'MOVE' | 'EXPUNGE';

interface UidArgs {
	readonly sub: UidSubVerb;
	readonly rest: string[];
}

/**
 * UID prefix dispatcher. UID FETCH / UID STORE / UID COPY / UID MOVE /
 * UID EXPUNGE re-enter the matching sub-module with the `byUid: true`
 * flag set. The sub-modules' parseArgs handle the post-verb args; this
 * module just routes by the leading sub-verb token.
 *
 * Single-file delegation rather than splitting into one walker entry
 * per sub-verb — the IMAP parser returns the verb as `UID` and the
 * sub-verb sits in args[0]; the dispatcher decision belongs in one
 * place.
 */
export const uidModule: ImapCommandModule<UidArgs> = {
	verbs: ['UID'],
	capabilities: ['UIDPLUS'],
	parseArgs(rawArgs) {
		const first = rawArgs[0];
		if (first === undefined) {
			return { ok: false, error: 'UID requires a sub-command' };
		}
		const sub = first.toUpperCase();
		if (
			sub !== 'FETCH' &&
			sub !== 'STORE' &&
			sub !== 'COPY' &&
			sub !== 'MOVE' &&
			sub !== 'EXPUNGE'
		) {
			return { ok: false, error: `UID ${sub} not supported` };
		}
		return { ok: true, args: { sub, rest: rawArgs.slice(1) } };
	},
	start(start) {
		const { args, tag, send } = start;

		switch (args.sub) {
			case 'FETCH': {
				const parsed = fetchModule.parseArgs(args.rest);
				if (!parsed.ok) {
					send(`${tag} BAD ${parsed.error}`);
					return syncSession();
				}
				const next: FetchArgs = { ...parsed.args, byUid: true };
				return fetchModule.start({
					...start,
					verb: 'FETCH' as ImapVerb,
					args: next,
				});
			}
			case 'STORE': {
				const parsed = storeModule.parseArgs(args.rest);
				if (!parsed.ok) {
					send(`${tag} BAD ${parsed.error}`);
					return syncSession();
				}
				const next: StoreArgs = { ...parsed.args, byUid: true };
				return storeModule.start({
					...start,
					verb: 'STORE' as ImapVerb,
					args: next,
				});
			}
			case 'COPY': {
				const parsed = copyModule.parseArgs(args.rest);
				if (!parsed.ok) {
					send(`${tag} BAD ${parsed.error}`);
					return syncSession();
				}
				const next: CopyArgs = { ...parsed.args, byUid: true };
				return copyModule.start({
					...start,
					verb: 'COPY' as ImapVerb,
					args: next,
				});
			}
			case 'MOVE': {
				const parsed = moveModule.parseArgs(args.rest);
				if (!parsed.ok) {
					send(`${tag} BAD ${parsed.error}`);
					return syncSession();
				}
				const next: MoveArgs = { ...parsed.args, byUid: true };
				return moveModule.start({
					...start,
					verb: 'MOVE' as ImapVerb,
					args: next,
				});
			}
			case 'EXPUNGE': {
				// UID EXPUNGE takes an optional UID set in args.rest[0].
				const next: ExpungeArgs = { uidSpec: args.rest[0] };
				return expungeModule.start({
					...start,
					verb: 'EXPUNGE' as ImapVerb,
					args: next,
				});
			}
		}
	},
};
