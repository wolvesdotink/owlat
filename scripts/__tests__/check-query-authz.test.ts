/**
 * Conformance for the query-side authorization ratchet
 * (`apps/api/scripts/check-query-authz.sh`).
 *
 * The gate only ever recognized `authedQuery` / `chatQuery` / `assistantQuery`,
 * while the reads that carry the most org data — postbox, team inbox, knowledge
 * — are `publicQuery` exports that soft-fail in the handler. Ninety-odd reads
 * were therefore outside the gate's sight entirely, and a new one that forgot
 * its membership check would have passed.
 *
 * The cases here run the REAL script's `--generate` half (the violation lister,
 * before the shared ratchet compares it to the baseline) against throwaway
 * `apps/api` trees, and pin each way a read can satisfy the rule: a recognized
 * gate call, a soft-fail predicate, an `// authz:` / `// all-members:` opt-out —
 * plus the cases that must still be reported.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { apiTree, removeTrees, runGate } from './convexGates.testlib';

const GATE = 'check-query-authz.sh';

const roots: string[] = [];

afterAll(() => removeTrees(roots));

/** `file:name` pairs the gate reports for a throwaway tree holding `files`. */
async function violations(files: Record<string, string>): Promise<string[]> {
	const result = await runGate(await apiTree(files, roots), GATE, ['--generate']);
	if (result.code !== 0)
		throw new Error(`${GATE} --generate exited ${result.code}:\n${result.output}`);
	return result.stdout.split('\n').filter((line) => line.length > 0);
}

/** A read built with `builder` whose handler body is `body`. */
function read(builder: string, body: string, note = ''): string {
	return [
		note,
		`export const listThreads = ${builder}({`,
		'\targs: {},',
		'\thandler: async (ctx) => {',
		body,
		'\t\treturn [];',
		'\t},',
		'});',
		'',
	]
		.filter((line) => line !== '')
		.join('\n');
}

describe('convex query authorization ratchet', () => {
	it.each([
		'authedQuery',
		'chatQuery',
		'assistantQuery',
		'postboxQuery',
		'publicQuery',
		'publicAction',
	])('reports a %s that makes no authorization decision', async (builder) => {
		expect(
			await violations({
				'convex/mail/queries.ts': read(builder, '\t\tawait ctx.db.query("x");'),
			})
		).toEqual(['convex/mail/queries.ts:listThreads']);
	});

	it('says nothing about an internalQuery — server-only, no public surface', async () => {
		expect(await violations({ 'convex/mail/queries.ts': read('internalQuery', '') })).toEqual([]);
	});

	it('says nothing about an adminQuery — the role floor is the decision', async () => {
		expect(await violations({ 'convex/mail/queries.ts': read('adminQuery', '') })).toEqual([]);
	});

	// The throwing gates are the list check-permissions.sh accepts; before the
	// list moved into scripts/lib/convex-builders.sh this gate's copy lacked
	// requireContactsManage.
	it.each([
		'\t\tawait requireOrgPermission(ctx, "contacts:read");',
		'\t\trequirePermission(hasPermission(session.role, "contacts:read"));',
		'\t\tawait requireContactsManage(ctx, session);',
		'\t\tawait requireCampaignSendersManage(ctx, session);',
		'\t\tawait assertCanReadRoom(ctx, args.roomId, session);',
	])('accepts the throwing gate %j', async (gate) => {
		expect(await violations({ 'convex/mail/queries.ts': read('authedQuery', gate) })).toEqual([]);
	});

	// The predicates a soft-failing read uses instead of throwing: each answers
	// "may this caller read this?", and its caller returns empty on `false`.
	it.each([
		'\t\tif (!(await isActiveOrgMember(ctx))) return [];',
		'\t\tif (!isSharedInboxReader(session)) return [];',
		'\t\tconst mailbox = await loadReadableMailbox(ctx, args.mailboxId);',
		'\t\tconst message = await loadReadableMessage(ctx, args.messageId);',
		'\t\tconst boxes = await loadAccessibleMailboxes(ctx, userId, orgId);',
		'\t\tawait requireMailboxAccess(ctx, args.mailboxId);',
	])('accepts the in-handler gate %j', async (gate) => {
		expect(await violations({ 'convex/mail/queries.ts': read('publicQuery', gate) })).toEqual([]);
	});

	it('does NOT accept the `// public:` note as an authorization decision', async () => {
		const note = '// public: soft-auth — returns empty for anonymous';
		expect(
			await violations({ 'convex/mail/queries.ts': read('publicQuery', '\t\tconst x = 1;', note) })
		).toEqual(['convex/mail/queries.ts:listThreads']);
	});

	it.each([
		'// authz: the gate lives in the internal query this runs',
		'// all-members: the folder list is member-visible by design',
	])('accepts the opt-out comment %j above the export', async (note) => {
		expect(
			await violations({ 'convex/mail/queries.ts': read('publicQuery', '\t\tconst x = 1;', note) })
		).toEqual([]);
	});

	it('accepts an opt-out comment inside the handler body', async () => {
		expect(
			await violations({
				'convex/mail/queries.ts': read('publicQuery', '\t\t// authz: enforced downstream'),
			})
		).toEqual([]);
	});

	it('does not carry an opt-out comment across an intervening statement', async () => {
		expect(
			await violations({
				'convex/mail/queries.ts': [
					'// authz: this one is fine',
					'export const listFolders = publicQuery({',
					'\targs: {},',
					'\thandler: async () => [],',
					'});',
					'',
					'export const listThreads = publicQuery({',
					'\targs: {},',
					'\thandler: async () => [],',
					'});',
					'',
				].join('\n'),
			})
		).toEqual(['convex/mail/queries.ts:listThreads']);
	});

	describe('Team Inbox tables outside inbox/', () => {
		const inboxRead = read(
			'chatQuery',
			"\t\tawait assertCanReadRoom(ctx, room, userId);\n\t\tawait ctx.db.query('inboundMessages');"
		);

		it('reports a public read of an inbox table that does not import the reader gate', async () => {
			expect(await violations({ 'convex/chat/bridge.ts': inboxRead })).toEqual([
				'convex/chat/bridge.ts:#inbox-tables',
			]);
		});

		it('reports a public mutation that takes a thread id without the reader gate', async () => {
			const write = [
				'export const attach = chatMutation({',
				"\targs: { threadId: v.id('conversationThreads') },",
				'\thandler: async (ctx, args, session) => {',
				'\t\tawait assertCanAdministerRoom(ctx, room, session.userId, session.role);',
				'\t},',
				'});',
				'',
			].join('\n');
			expect(await violations({ 'convex/chat/bridge.ts': write })).toEqual([
				'convex/chat/bridge.ts:#inbox-tables',
			]);
		});

		it('accepts a file that imports inbox/access', async () => {
			const gated = `import { isSharedInboxReader } from '../inbox/access';\n${inboxRead}`;
			expect(await violations({ 'convex/chat/bridge.ts': gated })).toEqual([]);
		});

		it.each(['convex/inbox/queries.ts', 'convex/agent/steps/read.ts'])(
			'says nothing about %s — the inbox and agent planes own these tables',
			async (path) => {
				expect(await violations({ [path]: inboxRead })).toEqual([]);
			}
		);

		it('says nothing about a file with no public function', async () => {
			const internal = read('internalQuery', "\t\tawait ctx.db.query('conversationThreads');");
			expect(await violations({ 'convex/maintenance/sweep.ts': internal })).toEqual([]);
		});
	});
});
