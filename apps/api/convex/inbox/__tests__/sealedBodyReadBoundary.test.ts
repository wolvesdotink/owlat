/**
 * Sealed Mail E8b — the READ BOUNDARY of the team-inbox surfaces.
 *
 * The `mailMessages` sibling of this file covers the Postbox; this one covers
 * the other body-bearing table the UI renders row-by-row. `inboundMessages`
 * bodies are sealed at rest, and the thread view, the review queue, the
 * quarantine list and the failed list all hand the caller whole rows — so
 * before the fix each of them shipped `atrest:1:…` envelopes to a page that
 * renders the body column as text.
 *
 * Same boundary rule as the Postbox side: sealing is an AT-REST property, so a
 * row leaving an access-checked read carries plaintext, while a
 * legacy-plaintext row (pre-E8b, or one the back-fill has not reached) is
 * returned verbatim.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { sealMessageBody } from '../../lib/messageBody';
import { isSealedAtRest } from '../../lib/atRestBodies';

// See receiveMessageAuth.test.ts: the `../../**` glob omits the `inbox/` dir it
// climbed through, so merge a second glob rooted at `inbox/` and re-prefix it.
const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...inboxGlob }).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const INSTANCE_SECRET = 'unit-test-instance-secret-value';
const TEXT = 'Hallo, ich habe eine Frage zur Rechnung.';
const HTML = '<p>Hallo, ich habe eine Frage zur Rechnung.</p>';

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
	vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId: 'test-user',
		role: 'owner',
		activeOrganizationId: 'test-org',
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;
type ProcessingStatus = 'draft_ready' | 'quarantined' | 'failed' | 'received';

/** One inbound row with SEALED bodies, optionally attached to a thread. */
async function seedSealedInbound(
	t: T,
	over: { status?: ProcessingStatus; threadId?: Id<'conversationThreads'> } = {}
): Promise<Id<'inboundMessages'>> {
	const textBody = await sealMessageBody(TEXT);
	const htmlBody = await sealMessageBody(HTML);
	expect(isSealedAtRest(textBody)).toBe(true);
	return t.run(async (ctx: { db: DatabaseWriter }) => {
		return ctx.db.insert('inboundMessages', {
			messageId: `<inbound-${Math.random()}@sender.test>`,
			from: 'ana@acme.test',
			to: 'support@org.example',
			subject: 'Rechnung',
			textBody,
			htmlBody,
			processingStatus: over.status ?? 'received',
			...(over.threadId ? { threadId: over.threadId } : {}),
			receivedAt: Date.now(),
		});
	});
}

/** A conversation thread for the detail view to load messages under. */
async function seedThread(t: T): Promise<Id<'conversationThreads'>> {
	return t.run(async (ctx: { db: DatabaseWriter }) => {
		const now = Date.now();
		return ctx.db.insert('conversationThreads', {
			subject: 'Rechnung',
			normalizedSubject: 'rechnung',
			contactIdentifier: 'ana@acme.test',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
		});
	});
}

function expectPlaintextBody(row: { textBody?: string; htmlBody?: string }): void {
	expect(row.textBody).toBe(TEXT);
	expect(row.htmlBody).toBe(HTML);
}

describe('inboundMessages read boundary — sealed bodies leave as plaintext', () => {
	it('getThread: the thread view carries decrypted message bodies', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		await seedSealedInbound(t, { threadId });

		const result = await t.query(api.inbox.queries.getThread, { threadId });
		expect(result?.messages).toHaveLength(1);
		expectPlaintextBody(result!.messages[0]!);
	});

	it('getReviewQueue: a pending draft carries a decrypted body', async () => {
		const t = convexTest(schema, modules);
		await seedSealedInbound(t, { status: 'draft_ready' });

		const queue = await t.query(api.inbox.queries.getReviewQueue, {});
		expect(queue).toHaveLength(1);
		expectPlaintextBody(queue[0]!.message);
	});

	it('getQuarantined: the admin review list carries a decrypted body', async () => {
		const t = convexTest(schema, modules);
		await seedSealedInbound(t, { status: 'quarantined' });

		const rows = await t.query(api.inbox.queries.getQuarantined, {});
		expect(rows).toHaveLength(1);
		expectPlaintextBody(rows[0]!);
	});

	it('getFailed: the terminal-failure list carries a decrypted body', async () => {
		const t = convexTest(schema, modules);
		await seedSealedInbound(t, { status: 'failed' });

		const rows = await t.query(api.inbox.queries.getFailed, {});
		expect(rows).toHaveLength(1);
		expectPlaintextBody(rows[0]!);
	});

	it('a legacy-plaintext row is returned verbatim, absent columns stay absent', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.insert('inboundMessages', {
				messageId: '<legacy@sender.test>',
				from: 'ana@acme.test',
				to: 'support@org.example',
				subject: 'Rechnung',
				textBody: 'plain legacy body',
				processingStatus: 'quarantined',
				receivedAt: Date.now(),
			});
		});

		const rows = await t.query(api.inbox.queries.getQuarantined, {});
		expect(rows[0]?.textBody).toBe('plain legacy body');
		expect(rows[0]).not.toHaveProperty('htmlBody');
	});
});
