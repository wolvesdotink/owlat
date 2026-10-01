import type { ImapCommandModule } from '../types.js';
import { checkRequires } from '../helpers/auth.js';
import { syncSession } from '../helpers/session.js';
import { fetchModule } from '../fetch/index.js';
import { storeModule } from '../store/index.js';
import { copyModule } from '../copy/index.js';
import { moveModule } from '../move/index.js';
import { expungeModule } from '../expunge/index.js';

type UidSubVerb = 'FETCH' | 'STORE' | 'COPY' | 'MOVE' | 'EXPUNGE';

/** The args shape every UID-capable sub-module shares. */
interface UidCapableArgs {
	readonly byUid: boolean;
}

/**
 * The sub-modules a UID command can re-enter. Each one parses its own
 * post-verb args and reads `byUid` to switch from sequence numbers to
 * UIDs. Typing the table by the shared `byUid` field keeps one dispatch
 * path below: a module's `start` only ever receives the args its own
 * `parseArgs` produced, with `byUid` switched on.
 */
const UID_SUBCOMMANDS: Record<UidSubVerb, ImapCommandModule<UidCapableArgs>> = {
	FETCH: fetchModule,
	STORE: storeModule,
	COPY: copyModule,
	MOVE: moveModule,
	EXPUNGE: expungeModule,
};

function isUidSubVerb(sub: string): sub is UidSubVerb {
	return Object.hasOwn(UID_SUBCOMMANDS, sub);
}

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
 * The walker only sees the `UID` verb, so this dispatcher repeats the
 * walker's ceremony for the sub-module: parse (BAD on error), then the
 * sub-module's declared `requires`, then `start`.
 */
export const uidModule: ImapCommandModule<UidArgs> = {
	verbs: ['UID'],
	capabilities: ['UIDPLUS'],
	// Only UID FETCH may overlap; the other sub-commands write.
	concurrent({ sub, rest }) {
		if (sub !== 'FETCH') return false;
		const parsed = fetchModule.parseArgs(rest);
		return parsed.ok && (fetchModule.concurrent?.(parsed.args) ?? false);
	},
	parseArgs(rawArgs) {
		const first = rawArgs[0];
		if (first === undefined) {
			return { ok: false, error: 'UID requires a sub-command' };
		}
		const sub = first.toUpperCase();
		if (!isUidSubVerb(sub)) {
			return { ok: false, error: `UID ${sub} not supported` };
		}
		return { ok: true, args: { sub, rest: rawArgs.slice(1) } };
	},
	start(start) {
		const { args, state, tag, send } = start;
		const module = UID_SUBCOMMANDS[args.sub];

		const parsed = module.parseArgs(args.rest);
		if (!parsed.ok) {
			send(`${tag} BAD ${parsed.error}`);
			return syncSession();
		}
		const unmet = checkRequires(module.requires, state, tag);
		if (unmet) {
			send(unmet);
			return syncSession();
		}
		return module.start({
			...start,
			verb: args.sub,
			args: { ...parsed.args, byUid: true },
		});
	},
};
