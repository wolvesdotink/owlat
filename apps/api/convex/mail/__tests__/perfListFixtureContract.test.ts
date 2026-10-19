/**
 * The Postbox list-page fixture of the report-only structural-sharing benchmark
 * (scripts/perf-bench/postboxListPage.ts, plan item OW-072) against the server
 * it imitates. Executable contracts only, so an internal refactor of the list
 * reads cannot break them and a real change of the wire shape or limits does:
 *
 * - the fixture's row type matches the `listMessages` return type, key for key
 *   and field for field (ids and literal unions widened), at compile time;
 * - every fixture row survives the real `toMailListRow` projection unchanged,
 *   and its remaining keys are thread state;
 * - snippets are what the real `buildSnippet` produces at its cap;
 * - `listMessages` itself returns LIVE_PAGE_SIZE rows without a limit and
 *   SERVER_PAGE_CLAMP rows for any larger one.
 */

import { convexTest } from 'convex-test';
import type { FunctionReturnType } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { buildSnippet } from '../deliveryPipeline/insert';
import { toMailListRow, type RowThreadState } from '../mailbox/rowThreadState';
import {
	LIVE_PAGE_SIZE,
	SERVER_PAGE_CLAMP,
	SNIPPET_CODE_POINTS,
	THREAD_STATE_KEYS,
	listUpdates,
	type ListRow,
} from '../../../../../scripts/perf-bench/postboxListPage';
import { modules, seedFolder, seedMailbox } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
	};
});

beforeEach(() => {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId: 'test-user',
		role: 'owner',
		activeOrganizationId: 'test-org',
	});
});

// ── Compile-time: the fixture's row type is the wire row type ──────────────

type WireRow = FunctionReturnType<typeof api.mail.mailbox.queries.listMessages>['messages'][number];

/** Ids as plain strings and literal unions as their base type; structure kept. */
type Loose<T> = T extends string
	? string
	: T extends number
		? number
		: T extends boolean
			? boolean
			: T extends ReadonlyArray<infer U>
				? Loose<U>[]
				: T extends object
					? { [K in keyof T]: Loose<T[K]> }
					: T;

type Equal<A, B> =
	(<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

const ROW_KEYS_MATCH: Equal<keyof ListRow, keyof WireRow> = true;
const ROW_FIELDS_MATCH: Equal<Loose<ListRow>, Loose<WireRow>> = true;
const THREAD_KEYS_MATCH: Equal<(typeof THREAD_STATE_KEYS)[number], keyof RowThreadState> = true;

// ── Runtime ─────────────────────────────────────────────────────────────────

const THREAD_KEYS = new Set<string>(THREAD_STATE_KEYS);

function listPart(row: ListRow): Record<string, unknown> {
	return Object.fromEntries(Object.entries(row).filter(([key]) => !THREAD_KEYS.has(key)));
}

/** The stored message a fixture row would be projected from: every column a list never shows, too. */
function storedMessage(row: ListRow): Doc<'mailMessages'> {
	return {
		...listPart(row),
		uid: 1,
		modseq: 1,
		rfc822MessageId: `<${row._id}@example.com>`,
		references: ['<root@example.com>'],
		bccAddresses: [],
		normalizedSubject: row.subject,
		searchBody: row.snippet,
		rawStorageId: 'storage-id',
		rawSize: 4096,
		textBodyInline: row.snippet,
		flagDeleted: false,
		customFlags: [],
		internalDate: row.receivedAt,
		createdAt: row.receivedAt,
		updatedAt: row.receivedAt,
	} as unknown as Doc<'mailMessages'>;
}

describe('perf list-page fixture contract', () => {
	it('declares the row type listMessages returns', () => {
		expect([ROW_KEYS_MATCH, ROW_FIELDS_MATCH, THREAD_KEYS_MATCH]).toEqual([true, true, true]);
	});

	it.each([LIVE_PAGE_SIZE, SERVER_PAGE_CLAMP])(
		'every row of a %i-row page is a toMailListRow projection plus thread state',
		(size) => {
			for (const update of listUpdates(size)) {
				for (const row of update.next.messages) {
					expect(toMailListRow(storedMessage(row))).toStrictEqual(listPart(row));
				}
			}
		}
	);

	it('carries snippets as buildSnippet caps them', () => {
		expect(Array.from(buildSnippet('ä'.repeat(SNIPPET_CODE_POINTS * 3), undefined))).toHaveLength(
			SNIPPET_CODE_POINTS
		);
		// buildSnippet trims, then cuts, so a snippet at the cap is what it makes of
		// any longer body starting with it (trailing space included); a shorter
		// one is a whole body.
		const rows = listUpdates(SERVER_PAGE_CLAMP)[0]!.prev.messages;
		expect(rows.some((row) => Array.from(row.snippet).length === SNIPPET_CODE_POINTS)).toBe(true);
		for (const row of rows) {
			const atCap = Array.from(row.snippet).length === SNIPPET_CODE_POINTS;
			const body = atCap ? `${row.snippet}and the rest of the message body` : row.snippet;
			expect(buildSnippet(body, undefined)).toBe(row.snippet);
		}
	});

	it('pages LIVE_PAGE_SIZE rows by default and at most SERVER_PAGE_CLAMP', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
		});
		const folderId = await seedFolder(t, mailboxId, 'inbox');
		await t.run(async (ctx) => {
			const now = Date.now();
			const threadId: Id<'mailThreads'> = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'digest',
				participants: ['news@example.com'],
				messageCount: SERVER_PAGE_CLAMP + 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'digest',
				latestFromAddress: 'news@example.com',
				latestSubject: 'digest',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			for (let i = 0; i <= SERVER_PAGE_CLAMP; i++) {
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId,
					uid: i + 1,
					modseq: 1,
					rfc822MessageId: `<digest-${i}@example.com>`,
					threadId,
					fromAddress: 'news@example.com',
					toAddresses: ['me@example.com'],
					ccAddresses: [],
					bccAddresses: [],
					subject: `Digest ${i}`,
					normalizedSubject: `digest ${i}`,
					snippet: `Digest ${i}`,
					rawStorageId,
					rawSize: 3,
					attachments: [],
					hasAttachments: false,
					flagSeen: true,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: now - i * 1000,
					internalDate: now - i * 1000,
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const byDefault = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(byDefault.messages).toHaveLength(LIVE_PAGE_SIZE);
		expect(byDefault.hasMore).toBe(true);

		const asked = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			limit: SERVER_PAGE_CLAMP * 2,
		});
		expect(asked.messages).toHaveLength(SERVER_PAGE_CLAMP);
		expect(asked.hasMore).toBe(true);
	});
});
