import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/contentScreening.js', () => ({
	screenContent: vi.fn(),
}));

import { contentScreeningPhase } from '../contentScreening.js';
import { screenContent } from '../../../intelligence/contentScreening.js';
import type { PhaseDeps } from '../../types.js';
import type { MtaConfig } from '../../../config.js';
import { makeDispatchCtx } from '../../../__tests__/helpers/dispatchCtx.js';

function makeDeps(overrides: Partial<MtaConfig> = {}): PhaseDeps {
	return {
		redis: {} as never,
		config: { contentScreeningEnabled: true, ...overrides } as MtaConfig,
	};
}

beforeEach(() => vi.clearAllMocks());

describe('contentScreeningPhase', () => {
	it('continues when screening passes', async () => {
		vi.mocked(screenContent).mockResolvedValueOnce({ allowed: true });
		const out = await contentScreeningPhase.run(makeDeps(), makeDispatchCtx());
		expect(out.kind).toBe('continue');
	});

	it('drops with status=screened when screening rejects', async () => {
		vi.mocked(screenContent).mockResolvedValueOnce({ allowed: false, reason: 'spam_score:18' });
		const out = await contentScreeningPhase.run(makeDeps(), makeDispatchCtx());
		expect(out).toEqual({
			kind: 'drop',
			status: 'screened',
			reason: 'spam_score:18',
		});
	});

	it('drops with a fallback reason when screener gives none', async () => {
		vi.mocked(screenContent).mockResolvedValueOnce({ allowed: false });
		const out = await contentScreeningPhase.run(makeDeps(), makeDispatchCtx());
		expect(out.kind).toBe('drop');
		if (out.kind === 'drop') expect(out.reason).toBe('content_screened');
	});

	it('continues without calling screener when config.contentScreeningEnabled is false', async () => {
		const out = await contentScreeningPhase.run(
			makeDeps({ contentScreeningEnabled: false }),
			makeDispatchCtx()
		);
		expect(out.kind).toBe('continue');
		expect(screenContent).not.toHaveBeenCalled();
	});
});
