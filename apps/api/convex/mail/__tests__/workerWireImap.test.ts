/**
 * The IMAP wire fixtures are what these handlers answer.
 *
 * Each case seeds the one mailbox the fixtures describe
 * (`workerWireImap.testlib.ts`), runs the real handler the IMAP server calls,
 * and requires the answer to equal the frozen fixture once its placeholders are
 * bound to the ids this deployment minted. convex-test also holds every answer
 * to the function's registered `returns`, so a handler that drifts from the
 * contract fails here twice: against the validator, and against the bytes the
 * IMAP server's own suite parses.
 */

import { IMAP_WIRE_VERSION, IMAP_WIRE_MIN_SUPPORTED } from '@owlat/shared/imapWire';
import { IMAP_ENDPOINTS } from '@owlat/worker-protocol/imap';
import {
	bindWirePlaceholders,
	IMAP_WIRE_FIXTURES,
	IMAP_WIRE_IDS,
	WIRE_FIXTURE_NOW,
} from '@owlat/worker-protocol/wireFixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import {
	IMAP_FIXTURE_ADDRESS,
	IMAP_FIXTURE_PASSWORD,
	seedImapWireWorld,
	type ImapWireWorld,
} from './workerWireImap.testlib';

type Endpoint = keyof typeof IMAP_ENDPOINTS;
type Drive = (w: ImapWireWorld) => Promise<unknown>;

const I = IMAP_WIRE_IDS;

/** Bind a placeholder to a value the deployment minted, after checking it is a string. */
function bindMinted(w: ImapWireWorld, placeholder: string, value: unknown): void {
	expect(typeof value).toBe('string');
	w.ids[placeholder] = value as string;
}

const DRIVES: { readonly [K in Endpoint]: Readonly<Record<string, Drive>> } = {
	verifyAppPassword: {
		verified: (w) =>
			w.t.action(internal.mail.appPasswords.verify, {
				address: IMAP_FIXTURE_ADDRESS,
				password: IMAP_FIXTURE_PASSWORD,
				scope: 'imap',
				ip: '192.0.2.10',
				imapWireVersion: IMAP_WIRE_VERSION,
			}),
		refused: (w) =>
			w.t.action(internal.mail.appPasswords.verify, {
				address: IMAP_FIXTURE_ADDRESS,
				password: 'ABCDwrong-password',
				scope: 'imap',
				imapWireVersion: IMAP_WIRE_VERSION,
			}),
	},
	touchAppPassword: {
		recorded: (w) =>
			w.t.mutation(internal.mail.appPasswords.touch, {
				appPasswordId: w.ids[I.appPassword] as never,
				ip: '192.0.2.10',
				userAgent: 'Fixture Mail/1.0',
				imapWireVersion: IMAP_WIRE_VERSION,
			}),
	},
	reportServer: {
		current: (w) => report(w, IMAP_WIRE_VERSION),
		'server too old': (w) => report(w, IMAP_WIRE_MIN_SUPPORTED - 1),
		'backend older': (w) => report(w, IMAP_WIRE_VERSION + 1),
	},
	listFolders: {
		'system and user folders': (w) =>
			w.t.query(internal.mail.imap.session.listFolders, { mailboxId: w.mailboxId }),
	},
	selectFolder: {
		'with an unseen message': (w) =>
			w.t.query(internal.mail.imap.session.selectFolder, { folderId: w.folders.inbox }),
		'all seen': (w) =>
			w.t.query(internal.mail.imap.session.selectFolder, { folderId: w.folders.sent }),
		gone: (w) => w.t.query(internal.mail.imap.session.selectFolder, { folderId: w.folders.gone }),
	},
	fetchEnvelopes: {
		'whole window': (w) =>
			w.t.query(internal.mail.imap.fetch.fetchEnvelopes, {
				folderId: w.folders.inbox,
				uidLow: 1,
				uidHigh: 100,
			}),
		'full page': (w) =>
			w.t.query(internal.mail.imap.fetch.fetchEnvelopes, {
				folderId: w.folders.inbox,
				uidLow: 1,
				uidHigh: 100,
				ranges: [{ low: 1, high: 2 }],
				limit: 1,
			}),
	},
	fetchChangedEnvelopes: {
		'one changed row': async (w) => {
			const page = await w.t.query(internal.mail.imap.fetch.fetchChangedEnvelopes, {
				folderId: w.folders.inbox,
				modseqSince: 4,
				paginationOpts: { numItems: 50, cursor: null },
			});
			bindMinted(w, I.changedCursor, page.continueCursor);
			return page;
		},
	},
	listFolderUidsPage: {
		'whole folder': (w) =>
			w.t.query(internal.mail.imap.fetch.listFolderUidsPage, { folderId: w.folders.inbox }),
		'full page': (w) =>
			w.t.query(internal.mail.imap.fetch.listFolderUidsPage, {
				folderId: w.folders.inbox,
				limit: 1,
			}),
	},
	folderMembershipPage: {
		'not maintained': (w) =>
			w.t.query(internal.mail.imap.fetch.folderMembershipPage, { folderId: w.folders.sent }),
		'still building': (w) =>
			w.t.query(internal.mail.imap.fetch.folderMembershipPage, { folderId: w.folders.receipts }),
		blocks: (w) =>
			w.t.query(internal.mail.imap.fetch.folderMembershipPage, { folderId: w.folders.inbox }),
		unchanged: (w) =>
			w.t.query(internal.mail.imap.fetch.folderMembershipPage, {
				folderId: w.folders.inbox,
				knownVersion: w.ids[I.inboxMembership],
			}),
	},
	peekFolderModseq: {
		counters: (w) =>
			w.t.query(internal.mail.imap.session.peekFolderModseq, { folderId: w.folders.inbox }),
		gone: (w) =>
			w.t.query(internal.mail.imap.session.peekFolderModseq, { folderId: w.folders.gone }),
	},
	resolveSpecialFolder: {
		found: (w) =>
			w.t.query(internal.mail.imap.session.resolveSpecialFolder, {
				mailboxId: w.mailboxId,
				role: 'sent',
			}),
		none: (w) =>
			w.t.query(internal.mail.imap.session.resolveSpecialFolder, {
				mailboxId: w.mailboxId,
				role: 'trash',
			}),
	},
	storeFlags: {
		'one updated, one changed since': (w) =>
			w.t.mutation(internal.mail.imap.flags.storeFlags, {
				messageIds: [w.messages.one, w.messages.two],
				flags: ['\\Seen'],
				mode: 'add',
				unchangedSinceModseq: 4,
			}),
	},
	copyMessages: {
		copied: (w) =>
			w.t.mutation(internal.mail.imap.move.copyMessages, {
				sourceFolderId: w.folders.inbox,
				targetFolderId: w.folders.receipts,
				messageIds: [w.messages.one],
			}),
	},
	moveMessages: {
		moved: (w) =>
			w.t.mutation(internal.mail.imap.move.moveMessages, {
				sourceFolderId: w.folders.inbox,
				targetFolderId: w.folders.receipts,
				messageIds: [w.messages.one],
			}),
	},
	expungeFolder: {
		'one page': (w) =>
			w.t.mutation(internal.mail.imap.move.expungeFolder, {
				folderId: w.folders.inbox,
				imapWireVersion: IMAP_WIRE_VERSION,
			}),
		'folder gone': (w) =>
			w.t.mutation(internal.mail.imap.move.expungeFolder, {
				folderId: w.folders.gone,
				imapWireVersion: IMAP_WIRE_VERSION,
			}),
	},
	discardCopies: {
		removed: async (w) => {
			await w.t.mutation(internal.mail.imap.move.copyMessages, {
				sourceFolderId: w.folders.inbox,
				targetFolderId: w.folders.receipts,
				messageIds: [w.messages.one],
			});
			return await w.t.mutation(internal.mail.imap.move.discardCopies, {
				targetFolderId: w.folders.receipts,
				uids: [1],
			});
		},
	},
	appendMessage: {
		appended: async (w) => {
			const rawStorageId = await w.t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
			const result = await w.t.mutation(internal.mail.imap.append.appendMessage, {
				folderId: w.folders.sent,
				rawStorageId,
				rawSize: 3,
				rfc822MessageId: 'sent-3@owlat.example',
				fromAddress: IMAP_FIXTURE_ADDRESS,
				toAddresses: ['ada@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Re: Quarterly numbers',
				textBodyInline: 'Thanks.',
				flags: ['\\Seen'],
			});
			const stored = await w.t.run((ctx) => ctx.db.get(result.messageId));
			expect(stored?.folderId).toBe(w.folders.sent);
			w.ids[I.appended] = result.messageId;
			return result;
		},
	},
	resolveMessageIdsByUid: {
		'whole window': (w) =>
			w.t.query(internal.mail.imap.fetch.resolveMessageIdsByUid, {
				folderId: w.folders.inbox,
				uidLow: 1,
				uidHigh: 100,
			}),
	},
	getRawStorageUrls: {
		'one stored, one gone': async (w) => {
			const rows = await w.t.action(internal.mail.imap.fetch.getRawStorageUrls, {
				messageIds: [w.messages.one, w.messages.gone],
			});
			bindMinted(w, I.rawUrl, rows[0]?.url);
			return rows;
		},
	},
	generateUploadUrl: {
		minted: async (w) => {
			const url = await w.t.mutation(internal.mail.imap.append.generateRawUploadUrl, {});
			bindMinted(w, I.uploadUrl, url);
			return url;
		},
	},
};

function report(w: ImapWireWorld, wireVersion: number) {
	return w.t.mutation(internal.mail.imap.serverRegistry.report, {
		instanceId: 'imap-fixture',
		hostLabel: 'imap-1',
		owlatVersion: '0.6.16',
		wireVersion,
		startedAt: WIRE_FIXTURE_NOW - 60_000,
	});
}

beforeEach(() => {
	vi.useFakeTimers({ now: WIRE_FIXTURE_NOW });
});
afterEach(() => {
	vi.useRealTimers();
});

const FIXTURE_CASES = (Object.keys(IMAP_ENDPOINTS) as Endpoint[]).flatMap((key) =>
	IMAP_WIRE_FIXTURES[key].map((fixture) => [`${key}: ${fixture.name}`, key, fixture] as const)
);

describe('IMAP wire fixtures are what the handlers answer', () => {
	it('drives every fixture case, and only those', () => {
		for (const key of Object.keys(IMAP_ENDPOINTS) as Endpoint[]) {
			expect(Object.keys(DRIVES[key]).sort(), key).toEqual(
				IMAP_WIRE_FIXTURES[key].map((fixture) => fixture.name).sort()
			);
		}
	});

	it.each(FIXTURE_CASES)('%s', async (_title, key, fixture) => {
		const w = await seedImapWireWorld();
		const answer = await DRIVES[key][fixture.name]!(w);
		expect(answer).toEqual(bindWirePlaceholders(fixture.value, w.ids));
	});
});
