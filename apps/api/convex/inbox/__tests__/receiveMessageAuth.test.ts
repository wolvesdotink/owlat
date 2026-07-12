/**
 * Sealed Mail A1 — inbound auth-verdict persistence on the AI-inbox path.
 *
 * The MTA computes SPF/DKIM/DMARC over the raw bytes at ingest, but the
 * AI-inbox path (`webhooks/dispatcher.ts` → `inbox.messages.receiveMessage` →
 * `inboundMessages`) used to DROP the verdicts — only the personal-mailbox
 * path (`mailMessages`) carried them. This asserts `receiveMessage` now
 * PERSISTS the four verdict fields, and that an old-MTA message with the
 * fields absent stores them absent (they render as "unknown" downstream,
 * NEVER as "pass").
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
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

async function getRow(t: ReturnType<typeof convexTest>, messageId: string) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		return await ctx.db
			.query('inboundMessages')
			.withIndex('by_message_id', (q) => q.eq('messageId', messageId))
			.first();
	});
}

describe('inbox.messages.receiveMessage — inbound auth-verdict persistence (Sealed Mail A1)', () => {
	it('persists SPF/DKIM/DMARC verdicts + policy on the AI-inbox path', async () => {
		const t = convexTest(schema, modules);
		const messageId = '<auth-pass-1@sender.example>';

		await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Alice <alice@sender.example>',
			to: 'support@org.example',
			subject: 'Hello there',
			textBody: 'Body text',
			messageId,
			timestamp: Date.now(),
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			dmarcPolicy: 'reject',
		});

		const row = await getRow(t, messageId);
		expect(row).not.toBeNull();
		expect(row?.spfResult).toBe('pass');
		expect(row?.dkimResult).toBe('pass');
		expect(row?.dmarcResult).toBe('pass');
		expect(row?.dmarcPolicy).toBe('reject');
	});

	it('persists a failing DMARC verdict verbatim (never upgraded)', async () => {
		const t = convexTest(schema, modules);
		const messageId = '<auth-fail-1@spoofer.example>';

		await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Boss <boss@org.example>',
			to: 'support@org.example',
			subject: 'Wire the funds',
			textBody: 'Please pay this invoice',
			messageId,
			timestamp: Date.now(),
			spfResult: 'fail',
			dkimResult: 'none',
			dmarcResult: 'fail',
			dmarcPolicy: 'quarantine',
		});

		const row = await getRow(t, messageId);
		expect(row?.spfResult).toBe('fail');
		expect(row?.dkimResult).toBe('none');
		expect(row?.dmarcResult).toBe('fail');
		expect(row?.dmarcPolicy).toBe('quarantine');
	});

	it('stores the verdicts as ABSENT when an old MTA omits them (never defaults to "pass")', async () => {
		const t = convexTest(schema, modules);
		const messageId = '<old-mta-1@sender.example>';

		await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Carol <carol@sender.example>',
			to: 'support@org.example',
			subject: 'Legacy path',
			textBody: 'No verdicts on this one',
			messageId,
			timestamp: Date.now(),
			// No spf/dkim/dmarc fields — an MTA that predates this change.
		});

		const row = await getRow(t, messageId);
		expect(row).not.toBeNull();
		expect(row?.spfResult).toBeUndefined();
		expect(row?.dkimResult).toBeUndefined();
		expect(row?.dmarcResult).toBeUndefined();
		expect(row?.dmarcPolicy).toBeUndefined();
	});
});
