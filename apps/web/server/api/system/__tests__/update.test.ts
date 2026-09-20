import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';

/**
 * Route tests for `POST /api/system/update` — the in-app "Update now" button.
 *
 * The route used to answer 500 for every operator who pressed it: it recorded
 * its audit row by calling `internal.systemUpdates.recordUpdateStart` through
 * a session-authed `ConvexHttpClient`, which can only reach the PUBLIC function
 * surface ("Could not find public function for …"). The internal reference was
 * re-tagged as public at the call site to make it compile, so nothing short of
 * a real deployment could notice, and the unhandled rejection took the whole
 * request down before the updater was ever dispatched.
 *
 * These cases pin the shape that failure argues for: the record calls address
 * `api.*`, and neither of them can stop the update itself.
 */

const {
	requirePlatformAdminMock,
	getInstanceSecretMock,
	callUpdaterMock,
	resolveComposeMock,
	mutationMock,
} = vi.hoisted(() => ({
	requirePlatformAdminMock: vi.fn(),
	getInstanceSecretMock: vi.fn(),
	callUpdaterMock: vi.fn(),
	resolveComposeMock: vi.fn(),
	mutationMock: vi.fn(),
}));

vi.mock('~~/server/utils/requireAdmin', () => ({
	requirePlatformAdmin: requirePlatformAdminMock,
}));
vi.mock('~~/server/utils/updater', () => ({
	getInstanceSecret: getInstanceSecretMock,
	callUpdater: callUpdaterMock,
}));
vi.mock('~~/server/utils/composeUpdate', () => ({
	resolveVerifiedComposeTemplate: resolveComposeMock,
}));

const INSTANCE_SECRET = 's'.repeat(64);
const COMPOSE_TEMPLATE = 'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:0.4.17\n';

// The step blob the updater sidecar really returns — `ok` per docker step.
const SIDECAR_STEPS = [
	{ step: 'pull', ok: true, stdout: '', stderr: 'Pulling web ... done' },
	{ step: 'up', ok: true, stdout: 'Started', stderr: '' },
];

let body: unknown;

interface RouteResult {
	success?: boolean;
	runId?: string | null;
	versionFrom?: string;
	versionTo?: string;
	steps?: unknown;
}

async function callRoute(): Promise<RouteResult> {
	const mod = await import('../update.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<RouteResult>;
	return handler({});
}

function updaterResponse(ok: boolean, payload: unknown) {
	return { ok, json: async () => payload };
}

/** The (functionName, args) pairs the route sent to Convex, in order. */
function convexCalls(): { name: string; args: Record<string, unknown> }[] {
	return mutationMock.mock.calls.map(([ref, args]) => ({
		name: getFunctionName(ref as Parameters<typeof getFunctionName>[0]),
		args: args as Record<string, unknown>,
	}));
}

beforeEach(() => {
	process.env['OWLAT_VERSION'] = '0.4.16';
	mutationMock.mockReset().mockResolvedValue('run-id-1');
	requirePlatformAdminMock.mockReset().mockResolvedValue({ mutation: mutationMock });
	getInstanceSecretMock.mockReset().mockReturnValue(INSTANCE_SECRET);
	resolveComposeMock.mockReset().mockResolvedValue(COMPOSE_TEMPLATE);
	callUpdaterMock
		.mockReset()
		.mockResolvedValue(updaterResponse(true, { success: true, steps: SIDECAR_STEPS }));
	body = { targetVersion: '0.4.17' };

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => body)
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string; data?: unknown }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data })
	);
});

describe('POST /api/system/update — gates', () => {
	it('propagates the platform-admin gate before touching the updater', async () => {
		requirePlatformAdminMock.mockRejectedValue(
			Object.assign(new Error('Platform admin access required'), { statusCode: 403 })
		);

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 403 });
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});

	it.each([
		['missing', {}],
		['not semver', { targetVersion: 'latest' }],
		['blank', { targetVersion: '   ' }],
	])('rejects a %s targetVersion with 400', async (_name, invalidBody) => {
		body = invalidBody;

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 400 });
		expect(resolveComposeMock).not.toHaveBeenCalled();
		expect(callUpdaterMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/system/update — audit trail', () => {
	it('records start and finish against the PUBLIC function surface', async () => {
		const result = await callRoute();

		// A `ConvexHttpClient` resolves public functions only — the names below
		// must be reachable there. Visibility itself is a compile-time property
		// of the reference (both surfaces stringify identically at runtime), so
		// the "never `internal.*` from a Nitro route" half is pinned statically
		// by server/__tests__/convexFunctionVisibility.test.ts.
		expect(convexCalls()).toEqual([
			{
				name: 'systemUpdates:recordUpdateStart',
				args: { versionFrom: '0.4.16', versionTo: '0.4.17' },
			},
			{
				name: 'systemUpdates:recordUpdateFinish',
				args: {
					runId: 'run-id-1',
					status: 'success',
					steps: SIDECAR_STEPS,
					error: undefined,
				},
			},
		]);
		expect(result).toMatchObject({
			success: true,
			runId: 'run-id-1',
			versionFrom: '0.4.16',
			versionTo: '0.4.17',
			steps: SIDECAR_STEPS,
		});
	});

	it('does not stamp an actor — Convex derives it from the session', async () => {
		await callRoute();

		expect(convexCalls()[0]?.args).not.toHaveProperty('initiatedBy');
	});

	it('closes the run as failed and answers 502 when the updater refuses', async () => {
		callUpdaterMock.mockResolvedValue(
			updaterResponse(false, {
				error: 'Compose template validation failed',
				steps: [{ step: 'pull', ok: false, stdout: '', stderr: 'manifest unknown' }],
			})
		);

		await expect(callRoute()).rejects.toMatchObject({
			statusCode: 502,
			message: 'Compose template validation failed',
		});
		expect(convexCalls()[1]).toMatchObject({
			name: 'systemUpdates:recordUpdateFinish',
			args: { runId: 'run-id-1', status: 'failed' },
		});
	});
});

describe('POST /api/system/update — the audit row cannot block the update', () => {
	it('still applies the update when recording the start fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mutationMock.mockRejectedValueOnce(new Error('Convex unreachable'));

		const result = await callRoute();

		// An operator reaching for "Update now" is often reaching for it BECAUSE
		// something is unwell; a Convex that cannot take the audit write must not
		// be what stops the update.
		expect(callUpdaterMock).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ success: true, runId: null });
		// No run was opened, so there is nothing to close.
		expect(convexCalls().map((c) => c.name)).toEqual(['systemUpdates:recordUpdateStart']);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it('still reports success when recording the finish fails', async () => {
		mutationMock
			.mockResolvedValueOnce('run-id-1')
			.mockRejectedValueOnce(new Error('auth dropped mid-update'));

		await expect(callRoute()).resolves.toMatchObject({ success: true });
	});
});
