import { describe, it, expect } from 'vitest';
import { statusModule } from '../index.js';
import { selectModule } from '../../select/index.js';
import { fn } from '../../../convex.js';
import type { ConvexClient } from '../../../convex.js';
import type { CommandDeps, ConnectionState, ImapVerb } from '../../types.js';

/**
 * A folder row as returned by `mail/imap:listFolders` — uidValidity and
 * uidNext are deliberately DISTINCT so the test catches a handler that
 * confuses the two.
 */
const FOLDER = {
	_id: 'folder-inbox',
	name: 'INBOX',
	role: 'inbox',
	subscribed: true,
	uidValidity: 1000,
	uidNext: 42,
	highestModseq: 7,
	totalCount: 5,
	unseenCount: 2,
};

/**
 * Minimal Convex stub: routes `listFolders` to the fixture and
 * `selectFolder` to the SELECT-shaped result so the cross-check can run.
 * Any other ref throws so a typo'd ref is loud rather than silent.
 */
function stubConvex(): ConvexClient {
	return {
		query: async (ref: unknown) => {
			if (ref === fn.listFolders) return [FOLDER];
			if (ref === fn.selectFolder) {
				return {
					folder: {
						_id: FOLDER._id,
						name: FOLDER.name,
						role: FOLDER.role,
						uidValidity: FOLDER.uidValidity,
						uidNext: FOLDER.uidNext,
						highestModseq: FOLDER.highestModseq,
						totalCount: FOLDER.totalCount,
						unseenCount: FOLDER.unseenCount,
					},
				};
			}
			throw new Error(`unexpected query ref: ${String(ref)}`);
		},
	} as unknown as ConvexClient;
}

const AUTHED: ConnectionState = {
	auth: {
		mailboxId: 'mbx-1',
		appPasswordId: 'app-1',
		address: 'user@example.com',
		userId: 'user-1',
	},
	selected: null,
	clientId: null,
};

function makeDeps(convex: ConvexClient): CommandDeps {
	return {
		convex,
		config: {} as CommandDeps['config'],
		rateLimiter: {} as CommandDeps['rateLimiter'],
		remoteIp: '127.0.0.1',
		capabilityLine: 'CAPABILITY IMAP4rev1',
		closeConnection: () => {},
		commit: () => {},
	};
}

/** Run a command module's `start` and collect every line it sends. */
async function runCommand(
	module: { parseArgs: (raw: string[]) => unknown; start: (a: never) => { completion: Promise<void> } },
	rawArgs: string[],
	verb: ImapVerb,
	convex: ConvexClient,
): Promise<string[]> {
	const lines: string[] = [];
	const parsed = module.parseArgs(rawArgs) as { ok: boolean; args: unknown };
	expect(parsed.ok).toBe(true);
	const session = module.start({
		deps: makeDeps(convex),
		state: AUTHED,
		args: parsed.args,
		tag: 'a',
		verb,
		send: (line: string) => lines.push(line),
	} as never);
	await session.completion;
	return lines;
}

describe('STATUS UIDVALIDITY', () => {
	it('reports the persisted uidValidity, not uidNext', async () => {
		const lines = await runCommand(
			statusModule,
			['INBOX', '(MESSAGES UIDNEXT UIDVALIDITY UNSEEN)'],
			'STATUS',
			stubConvex(),
		);

		const statusLine = lines.find((l) => l.startsWith('* STATUS'));
		expect(statusLine).toBeDefined();

		// UIDVALIDITY must be the persisted 1000, and UIDNEXT must be 42 —
		// two DISTINCT values. Pre-fix this emitted `UIDVALIDITY 42`.
		expect(statusLine).toContain('UIDVALIDITY 1000');
		expect(statusLine).toContain('UIDNEXT 42');
		expect(statusLine).not.toContain('UIDVALIDITY 42');
	});

	it("agrees with SELECT's [UIDVALIDITY n]", async () => {
		const convex = stubConvex();

		const statusLines = await runCommand(
			statusModule,
			['INBOX', '(UIDVALIDITY)'],
			'STATUS',
			convex,
		);
		const selectLines = await runCommand(
			selectModule,
			['INBOX'],
			'SELECT',
			convex,
		);

		const statusUidValidity = statusLines
			.find((l) => l.startsWith('* STATUS'))
			?.match(/UIDVALIDITY (\d+)/)?.[1];
		const selectUidValidity = selectLines
			.find((l) => l.includes('[UIDVALIDITY'))
			?.match(/\[UIDVALIDITY (\d+)\]/)?.[1];

		expect(statusUidValidity).toBe('1000');
		expect(selectUidValidity).toBe('1000');
		expect(statusUidValidity).toBe(selectUidValidity);
	});
});
