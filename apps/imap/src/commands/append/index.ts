import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { parseList } from '../../parser.js';
import { buildSnippet, parseAppendHeaders } from '../../mime.js';
import type {
	CommandSession,
	ImapCommandModule,
} from '../types.js';
import { syncSession } from '../helpers/session.js';
import { requireAuth } from '../helpers/auth.js';
import { resolveFolderByName } from '../helpers/folders.js';

export interface AppendArgs {
	readonly folderName: string;
	readonly flags: string[];
	readonly internalDate?: number;
	readonly expectedBytes: number;
	readonly isLiteralPlus: boolean;
}

/**
 * Upper bound on a declared APPEND literal. An unbounded `{N}` lets an
 * authenticated client make the pump buffer an arbitrarily large message
 * (memory exhaustion) and fill storage unmetered. 50 MiB comfortably covers a
 * real email with attachments; larger declarations are rejected with a tagged
 * NO. The connection pump also enforces `maxLiteralBytes` as a hard backstop.
 */
const MAX_APPEND_LITERAL_BYTES = 50 * 1024 * 1024;

interface AppendResult {
	readonly uid: number;
	readonly uidValidity: number;
	readonly modseq: number;
}

/**
 * APPEND — RFC 3501 + LITERAL+ (RFC 7888). Two phases:
 *
 *   1. Parse the command line: folder name, optional flag list,
 *      optional internal date, and the trailing `{N}` (continuation
 *      required) or `{N+}` (LITERAL+, no continuation) literal.
 *      `start` writes `+ Ready for literal data` for the non-LITERAL+
 *      case and sets `awaitingLiteral: { bytes: N }`.
 *   2. The pump absorbs N raw OCTETS from the wire into `onLiteralBytes`
 *      (the pump buffers Buffers, so `{N}` frames by bytes not decoded
 *      characters — 8-bit/binary bodies round-trip). Once N have arrived
 *      the module uploads to Convex storage, calls `mailImap:appendMessage`,
 *      and resolves `completion`.
 */
export const appendModule: ImapCommandModule<AppendArgs> = {
	verbs: ['APPEND'],
	capabilities: ['LITERAL+'],
	parseArgs(rawArgs) {
		const folderName = rawArgs[0];
		if (folderName === undefined) {
			return { ok: false, error: 'APPEND requires a mailbox name' };
		}
		let argIdx = 1;
		let flags: string[] = [];
		let internalDate: number | undefined;

		// Optional parenthesized flag list
		const flagToken = rawArgs[argIdx];
		if (flagToken?.startsWith('(') && flagToken.endsWith(')')) {
			flags = parseList(flagToken);
			argIdx += 1;
		}

		const maybeDate = rawArgs[argIdx];
		const literalMatch = rawArgs[rawArgs.length - 1]?.match(/^\{(\d+)\+?\}$/);
		if (!literalMatch) {
			return { ok: false, error: 'APPEND requires a {N} literal' };
		}
		const expectedBytes = parseInt(literalMatch[1] ?? '', 10);
		if (Number.isNaN(expectedBytes) || expectedBytes <= 0) {
			return { ok: false, error: 'APPEND literal size must be positive' };
		}
		if (expectedBytes > MAX_APPEND_LITERAL_BYTES) {
			return {
				ok: false,
				error: `[TOOBIG] APPEND literal exceeds the ${MAX_APPEND_LITERAL_BYTES}-byte limit`,
			};
		}

		// If maybeDate isn't the literal token itself, treat it as the date arg
		if (maybeDate && maybeDate !== rawArgs[rawArgs.length - 1]) {
			const parsed = Date.parse(maybeDate);
			if (!Number.isNaN(parsed)) internalDate = parsed;
		}

		const isLiteralPlus = literalMatch[0].endsWith('+}');

		return {
			ok: true,
			args: { folderName, flags, internalDate, expectedBytes, isLiteralPlus },
		};
	},
	start({ deps, state, args, tag, send }) {
		const fail = requireAuth(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		if (!args.isLiteralPlus) {
			send('+ Ready for literal data');
		}

		const chunks: Buffer[] = [];
		let bytesReceived = 0;
		let resolved = false;
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((r) => {
			resolveCompletion = r;
		});

		const finalize = (line?: string): void => {
			if (resolved) return;
			resolved = true;
			if (line) send(line);
			resolveCompletion();
		};

		const performUpload = async (): Promise<void> => {
			const rawBuffer = Buffer.concat(chunks);
			try {
				const folder = await resolveFolderByName(
					deps.convex,
					state.auth!.mailboxId,
					args.folderName,
				);
				if (!folder) {
					finalize(`${tag} NO [TRYCREATE] Mailbox not found`);
					return;
				}

				const uploadUrl = (await deps.convex.mutation(
					fn.generateUploadUrl as never,
					{} as never,
				)) as string;
				const uploadRes = await fetch(uploadUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'message/rfc822' },
					body: rawBuffer,
				});
				if (!uploadRes.ok) {
					finalize(`${tag} NO APPEND storage upload failed`);
					return;
				}
				const { storageId } = (await uploadRes.json()) as { storageId: string };

				const headers = parseAppendHeaders(rawBuffer);
				const snippet = buildSnippet(headers.textBody);

				const result = (await deps.convex.mutation(fn.appendMessage as never, {
					folderId: folder._id,
					rawStorageId: storageId,
					rawSize: rawBuffer.length,
					rfc822MessageId: headers.messageId,
					fromAddress: headers.from.address,
					fromName: headers.from.name,
					toAddresses: headers.to.map((a) => a.address),
					ccAddresses: headers.cc.map((a) => a.address),
					bccAddresses: headers.bcc.map((a) => a.address),
					subject: headers.subject,
					snippet,
					textBodyInline: headers.textBody?.slice(0, 65536),
					internalDate: args.internalDate ?? headers.internalDate,
					flags: args.flags,
				} as never)) as AppendResult;

				finalize(
					`${tag} OK [APPENDUID ${result.uidValidity} ${result.uid}] APPEND completed`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('From address not authorized')) {
					logger.warn(
						{
							ip: deps.remoteIp,
							address: state.auth?.address,
							folder: args.folderName,
						},
						'APPEND rejected — From address not authorized',
					);
					finalize(
						`${tag} NO [NO-PERM] From address not authorized for this mailbox`,
					);
					return;
				}
				logger.error({ err }, 'APPEND processing failed');
				finalize(`${tag} NO APPEND failed`);
			}
		};

		const session: CommandSession = {
			completion,
			awaitingLiteral: { bytes: args.expectedBytes },
			onLiteralBytes(buf) {
				if (resolved) return;
				chunks.push(buf);
				bytesReceived += buf.length;
				if (bytesReceived >= args.expectedBytes) {
					// Fire and forget — completion resolves when upload finishes
					performUpload().catch((err) => {
						logger.error({ err }, 'APPEND upload failed');
						finalize(`${tag} NO APPEND failed`);
					});
				}
			},
			cancel() {
				if (resolved) return;
				resolved = true;
				resolveCompletion();
			},
		};
		return session;
	},
};
