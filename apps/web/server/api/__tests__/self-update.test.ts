import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `POST /api/self-update`, the control plane's update trigger.
 *
 * It passed every non-2xx updater answer straight through. Since the updater
 * checks readiness after the recreate, a release that is applied and running
 * but has a service still coming up answers 500 with `rollout: 'started'`,
 * and the control plane read that as a failed update to retry.
 */

const { requireInstanceSecretMock, callUpdaterMock, resolveComposeMock } = vi.hoisted(() => ({
	requireInstanceSecretMock: vi.fn(),
	callUpdaterMock: vi.fn(),
	resolveComposeMock: vi.fn(),
}));

vi.mock('~~/server/utils/updater', () => ({
	requireInstanceSecret: requireInstanceSecretMock,
	callUpdater: callUpdaterMock,
}));
vi.mock('~~/server/utils/composeUpdate', () => ({
	resolveVerifiedComposeTemplate: resolveComposeMock,
}));

async function callRoute(): Promise<Record<string, unknown>> {
	const mod = await import('../self-update.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<Record<string, unknown>>;
	return handler({});
}

function updaterResponse(status: number, payload: unknown) {
	return { ok: status < 300, status, json: async () => payload };
}

beforeEach(() => {
	requireInstanceSecretMock.mockReset().mockReturnValue('s'.repeat(64));
	resolveComposeMock.mockReset().mockResolvedValue('services: {}\n');
	callUpdaterMock.mockReset();
	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => ({ targetVersion: '0.4.17' }))
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string; data?: unknown }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data })
	);
});

describe('POST /api/self-update', () => {
	it('answers a started-but-not-healthy rollout as a success with a warning', async () => {
		callUpdaterMock.mockResolvedValue(
			updaterResponse(500, {
				error: 'The release was applied … still starting: clamav.',
				rollout: 'started',
				steps: [],
			})
		);

		const result = await callRoute();

		expect(result).toMatchObject({ success: true, rollout: 'started' });
		expect(result['warning']).toContain('still starting: clamav');
		expect(result).not.toHaveProperty('error');
	});

	it('still passes a real failure through with its status', async () => {
		callUpdaterMock.mockResolvedValue(
			updaterResponse(500, { error: 'docker compose up failed', rollout: 'partially-applied' })
		);

		await expect(callRoute()).rejects.toMatchObject({
			statusCode: 500,
			message: 'docker compose up failed',
		});
	});

	it('returns a healthy rollout as the updater answered it', async () => {
		callUpdaterMock.mockResolvedValue(
			updaterResponse(200, { success: true, rollout: 'healthy', steps: [] })
		);

		await expect(callRoute()).resolves.toEqual({ success: true, rollout: 'healthy', steps: [] });
	});
});
