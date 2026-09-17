/**
 * Retention cap on `webhookPayloads.rawPayload` (`webhooks/payloads.ts`).
 *
 * Every caller of `payloads.store` is a webhook route that deliberately never
 * fails a delivery over its audit trail, so an insert that throws is swallowed.
 * A Convex document is capped at 1 MiB while the routes accept bodies up to
 * 5 MiB, which meant the audit trail silently did not exist for exactly the
 * largest deliveries. The cap turns that into a marked-truncated row.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { MAX_RETAINED_PAYLOAD_CHARS } from '../payloads';

const rootGlob = import.meta.glob('../../**/*.*s');
const webhooksGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../webhooks/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...webhooksGlob }).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

/** Convex's hard per-document limit. */
const CONVEX_DOCUMENT_MAX_BYTES = 1024 * 1024;

async function storedPayload(t: ReturnType<typeof convexTest>): Promise<string> {
	const rows = await t.run(async (ctx) => ctx.db.query('webhookPayloads').collect());
	const row = rows[0];
	if (!row) throw new Error('nothing retained');
	return row.rawPayload as string;
}

describe('webhookPayloads retention cap', () => {
	it('keeps a normal provider body verbatim', async () => {
		const t = convexTest(schema, modules);
		const body = JSON.stringify({ event: 'bounce', recipient: 'a@acme.test' });

		await t.mutation(internal.webhooks.payloads.store, { source: 'ses', rawPayload: body });

		expect(await storedPayload(t)).toBe(body);
	});

	it('retains an oversized body as a marked-truncated head instead of throwing', async () => {
		const t = convexTest(schema, modules);
		const body = 'x'.repeat(2 * 1024 * 1024);

		await t.mutation(internal.webhooks.payloads.store, { source: 'ses', rawPayload: body });

		const stored = await storedPayload(t);
		expect(new TextEncoder().encode(stored).length).toBeLessThan(CONVEX_DOCUMENT_MAX_BYTES);
		const envelope = JSON.parse(stored) as Record<string, unknown>;
		expect(envelope['truncated']).toBe(true);
		expect(envelope['originalChars']).toBe(body.length);
		expect(String(envelope['head'])).toHaveLength(MAX_RETAINED_PAYLOAD_CHARS);
	});
});
