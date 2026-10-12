/**
 * The decision plane identity is the RESOLVER's output (Sol r3 F2): a stored
 * provider kind with an env model or origin has the identity of the endpoint
 * `resolveDecisionConfig` would call, so changing either changes the identity
 * and an answer stamped under the old one no longer passes the gate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../_generated/server';
import type { Doc } from '../../../_generated/dataModel';
import { __resetDecisionPlaneCacheForTests, resolveDecisionConfig } from '../../decisionProvider';
import { resolvedPlaneIdentity } from '../configIdentity';
import { PINNED_DECISION_MODEL } from '../../decisionProviders/typesafe';

vi.mock('../../llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'language-model', provider: 'openai' })),
}));

let updatedAt = 1;

/** A stored row naming TypeSafe with no stored key, model or origin. */
function ctxWithStoredKind(over: Partial<Doc<'aiProviderConfig'>> = {}) {
	const row = {
		_id: 'cfg1',
		_creationTime: 0,
		languageProviderKind: 'openai',
		modelFast: 'fast',
		modelCapable: 'capable',
		embeddingProviderKind: 'local',
		embeddingModelVersion: 1,
		decisionProviderKind: 'typesafe',
		updatedAt: updatedAt++,
		...over,
	} as unknown as Doc<'aiProviderConfig'>;
	return { runQuery: vi.fn(async () => row), runAction: vi.fn() } as unknown as ActionCtx;
}

async function identityOf(ctx: ActionCtx): Promise<string> {
	__resetDecisionPlaneCacheForTests();
	return resolvedPlaneIdentity(await resolveDecisionConfig(ctx), true);
}

afterEach(() => {
	vi.unstubAllEnvs();
	__resetDecisionPlaneCacheForTests();
});

describe('the identity of a stored provider kind with env fallbacks', () => {
	it('takes the env model and origin the resolver falls back to', async () => {
		vi.stubEnv('TYPESAFE_API_KEY', 'ts-live-0123456789abcdef');
		vi.stubEnv('DECISION_MODEL', 'jev-1.14.0');
		vi.stubEnv('DECISION_BASE_URL', 'https://jev.proxy.example');
		expect(await identityOf(ctxWithStoredKind())).toBe(
			'typesafe|jev-1.14.0|https://jev.proxy.example'
		);
	});

	it('changes when the env model or the env origin changes', async () => {
		vi.stubEnv('TYPESAFE_API_KEY', 'ts-live-0123456789abcdef');
		const plain = await identityOf(ctxWithStoredKind());
		expect(plain).toBe(`typesafe|${PINNED_DECISION_MODEL}|`);
		vi.stubEnv('DECISION_MODEL', 'jev-1.14.0');
		const withModel = await identityOf(ctxWithStoredKind());
		vi.stubEnv('DECISION_BASE_URL', 'https://jev.proxy.example');
		const withOrigin = await identityOf(ctxWithStoredKind());
		expect(new Set([plain, withModel, withOrigin]).size).toBe(3);
	});

	it('lets a stored model and origin win over the environment, as the resolver does', async () => {
		vi.stubEnv('TYPESAFE_API_KEY', 'ts-live-0123456789abcdef');
		vi.stubEnv('DECISION_MODEL', 'jev-env');
		vi.stubEnv('DECISION_BASE_URL', 'https://env.proxy.example');
		expect(
			await identityOf(
				ctxWithStoredKind({
					decisionModel: 'jev-stored',
					decisionBaseUrl: 'https://stored.proxy.example',
				})
			)
		).toBe('typesafe|jev-stored|https://stored.proxy.example');
	});

	it('names a stored provider without a usable key as unavailable', async () => {
		expect(await identityOf(ctxWithStoredKind())).toBe('unavailable:typesafe');
	});
});
