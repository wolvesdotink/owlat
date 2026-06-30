import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { parseList } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect } from '../helpers/auth.js';
import { collectMessageIdsByUid } from '../helpers/uidSet.js';
import { buildSeqMap, resolveSet, seqForUid } from '../helpers/seqMap.js';

export interface StoreArgs {
	readonly set: string;
	readonly unchangedSince?: number;
	readonly silent: boolean;
	readonly mode: 'set' | 'add' | 'remove';
	readonly flagsToken: string;
	readonly byUid: boolean;
}

interface StoreFlagsResult {
	readonly updated: ReadonlyArray<{ uid: number; modseq: number; flags: string[] }>;
	readonly unchanged: ReadonlyArray<{ uid: number }>;
}

/**
 * STORE — set / add / remove flags on a UID set. CONDSTORE
 * `UNCHANGEDSINCE` clause optional. `.SILENT` suppresses the per-row
 * `* N FETCH` reply (but the OK still fires).
 */
export const storeModule: ImapCommandModule<StoreArgs> = {
	verbs: ['STORE'],
	capabilities: ['CONDSTORE'],
	parseArgs(rawArgs) {
		const set = rawArgs[0];
		if (set === undefined) {
			return { ok: false, error: 'STORE requires <set> <op> <flags>' };
		}
		let argIdx = 1;
		let unchangedSince: number | undefined;
		const condStoreToken = rawArgs[argIdx];
		if (condStoreToken?.toUpperCase().startsWith('(UNCHANGEDSINCE')) {
			const m = condStoreToken.match(/UNCHANGEDSINCE\s+(\d+)/i);
			unchangedSince = m ? parseInt(m[1] ?? '', 10) : undefined;
			argIdx += 1;
		}

		const opRaw = rawArgs[argIdx]?.toUpperCase();
		const flagsToken = rawArgs[argIdx + 1];
		if (!opRaw || !flagsToken) {
			return { ok: false, error: 'STORE requires <op> <flags>' };
		}

		const silent = opRaw.endsWith('.SILENT');
		const opCore = silent ? opRaw.slice(0, -7) : opRaw;
		let mode: 'set' | 'add' | 'remove';
		if (opCore === '+FLAGS') mode = 'add';
		else if (opCore === '-FLAGS') mode = 'remove';
		else if (opCore === 'FLAGS') mode = 'set';
		else return { ok: false, error: `Unknown STORE op ${opRaw}` };

		return {
			ok: true,
			args: { set, unchangedSince, silent, mode, flagsToken, byUid: false },
		};
	},
	start({ deps, state, args, tag, send }) {
		const fail = requireAuth(state, tag) ?? requireSelect(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}
		if (state.selected!.readOnly) {
			send(`${tag} NO Mailbox is read-only`);
			return syncSession();
		}

		const label = args.byUid ? 'UID STORE' : 'STORE';
		const flagList = parseList(args.flagsToken);

		return asyncSession(async () => {
			try {
				// Resolve the set against the folder's sequence ↔ UID map: a
				// non-UID set holds positions, a UID set holds UIDs. The map is
				// reused below to emit each updated row's true sequence number.
				const folderUids = (await deps.convex.query(
					fn.listFolderUids as never,
					{ folderId: state.selected!.folderId } as never,
				)) as number[];
				const seqMap = buildSeqMap(folderUids);
				const resolved = resolveSet(seqMap, args.set, args.byUid);
				if (resolved.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				// One range query over the resolved UIDs' min..max span; index the
				// rows by UID and pick exactly the resolved UIDs. A contiguous set
				// (`STORE 1:1000`) therefore costs a single Convex query rather than
				// one per message, mirroring the FETCH path, while gaps in the span
				// are excluded because only resolved UIDs are selected.
				const uids = resolved.map((r) => r.uid);
				const byUid = await collectMessageIdsByUid(
					deps.convex,
					state.selected!.folderId,
					Math.min(...uids),
					Math.max(...uids),
				);
				const messageIds: string[] = [];
				for (const uid of uids) {
					const id = byUid.get(uid);
					if (id !== undefined) messageIds.push(id);
				}
				if (messageIds.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				const result = (await deps.convex.mutation(fn.storeFlags as never, {
					messageIds,
					flags: flagList,
					mode: args.mode,
					unchangedSinceModseq: args.unchangedSince,
				} as never)) as StoreFlagsResult;

				if (!args.silent) {
					for (const u of result.updated) {
						const seq = seqForUid(seqMap, u.uid) ?? 0;
						send(
							`* ${seq} FETCH (UID ${u.uid} MODSEQ (${u.modseq}) FLAGS (${u.flags.join(' ')}))`,
						);
					}
				}

				if (result.unchanged.length > 0) {
					const modified = result.unchanged.map((u) => u.uid).join(',');
					send(`${tag} OK [MODIFIED ${modified}] ${label} completed`);
					return;
				}
				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'STORE failed');
				send(`${tag} BAD STORE failed`);
			}
		});
	},
};
