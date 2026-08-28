/**
 * translate.translateBatch — batch content translation.
 *
 * These tests cover the abuse guards added around the LLM call: the input caps
 * (batch size + total character volume) that reject an oversized request BEFORE
 * any dispatch, and the shared AI gate (`mail.aiGate.assertAiAllowed`, the `ai`
 * feature flag) that must run before a translation spends the LLM budget.
 *
 * Answer quality is not exercised — the LLM is never reached in these paths.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures } from './factories';

// Drive the org-member floor (authedAction wrapper) and the identity check the
// handler runs, without a real BetterAuth session.
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({
			userId: 'user-1',
			role: 'owner' as const,
			activeOrganizationId: 'test-org',
		}),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'user-1' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'user-1',
			role: 'owner' as const,
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('sesActions'))
);

function items(count: number, text = 'hello') {
	return Array.from({ length: count }, (_, i) => ({ id: `i${i}`, text, isHtml: false }));
}

describe('translate.translateBatch — input caps', () => {
	it('rejects a batch of more than 50 items before any dispatch', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		await expect(
			t.action(api.translate.translateBatch, {
				items: items(51),
				sourceLanguage: 'en',
				targetLanguage: 'de',
			})
		).rejects.toThrow(/too many items/i);
	});

	it('rejects a batch whose combined text exceeds the character cap', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		// 3 items × ~40k chars = 120k > the 100k cap, but only 3 items (under the
		// item cap), so this exercises the total-character clamp specifically.
		await expect(
			t.action(api.translate.translateBatch, {
				items: items(3, 'x'.repeat(40_000)),
				sourceLanguage: 'en',
				targetLanguage: 'de',
			})
		).rejects.toThrow(/too much text/i);
	});
});

describe('translate.translateBatch — AI gate', () => {
	it('is blocked when the ai feature flag is off (gate runs before the LLM)', async () => {
		const t = convexTest(schema, modules);
		// No instanceSettings row → the `ai` flag resolves to its default (off).
		await expect(
			t.action(api.translate.translateBatch, {
				items: items(1),
				sourceLanguage: 'en',
				targetLanguage: 'de',
			})
		).rejects.toThrow(/disabled|forbidden/i);
	});
});
