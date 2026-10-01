import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type * as ConvexDeploy from '../../lib/convexDeploy';

const { setConvexEnvVars, removeConvexEnvVars } = vi.hoisted(() => ({
	setConvexEnvVars: vi.fn(),
	removeConvexEnvVars: vi.fn(),
}));

// Only the docker-driven push is faked; the key selection and the admin-key
// check are the real ones `owlat quickstart` uses.
vi.mock('../../lib/convexDeploy', async (importOriginal) => ({
	...(await importOriginal<typeof ConvexDeploy>()),
	setConvexEnvVars,
	removeConvexEnvVars,
}));

import { runPushEnv } from '../pushEnv';

const ADMIN_KEY = 'convex-self-hosted|0123456789abcdef0123456789abcdef';
const roots: string[] = [];
let logSpy: MockInstance;
let errorSpy: MockInstance;

async function installWithEnv(env: string | null): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-push-env-'));
	roots.push(root);
	if (env !== null) await writeFile(join(root, '.env'), env);
	return root;
}

describe('owlat-setup push-env', () => {
	beforeEach(() => {
		setConvexEnvVars.mockReset();
		setConvexEnvVars.mockResolvedValue(undefined);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it('pushes the runtime keys from .env and leaves container-only keys behind', async () => {
		const root = await installWithEnv(
			[
				`CONVEX_ADMIN_KEY=${ADMIN_KEY}`,
				'EMAIL_PROVIDER=ses',
				'AWS_SES_REGION=eu-west-1',
				'EHLO_HOSTNAMES={"203.0.113.11":"mail2.example.com"}',
			].join('\n')
		);

		await expect(runPushEnv({ owlatDir: root })).resolves.toBe(0);

		expect(setConvexEnvVars).toHaveBeenCalledTimes(1);
		const [dir, vars] = setConvexEnvVars.mock.calls[0]!;
		expect(dir).toBe(root);
		const pushed = Object.fromEntries(vars as Array<[string, string]>);
		expect(pushed).toMatchObject({ EMAIL_PROVIDER: 'ses', AWS_SES_REGION: 'eu-west-1' });
		expect(pushed).not.toHaveProperty('EHLO_HOSTNAMES');
		expect(pushed).not.toHaveProperty('CONVEX_ADMIN_KEY');
	});

	it('stays additive: a blank or missing key is skipped, never removed', async () => {
		// Clearing a deployment value is `unset-env`'s job, never push-env's.
		const root = await installWithEnv(
			[`CONVEX_ADMIN_KEY=${ADMIN_KEY}`, 'EMAIL_PROVIDER=ses', 'LLM_BASE_URL='].join('\n')
		);

		await expect(runPushEnv({ owlatDir: root })).resolves.toBe(0);

		const pushed = Object.fromEntries(
			setConvexEnvVars.mock.calls[0]![1] as Array<[string, string]>
		);
		expect(pushed).toEqual({ EMAIL_PROVIDER: 'ses' });
		expect(removeConvexEnvVars).not.toHaveBeenCalled();
	});

	it('says why nothing was pushed when .env has no admin key', async () => {
		const root = await installWithEnv('EMAIL_PROVIDER=ses\n');

		await expect(runPushEnv({ owlatDir: root })).resolves.toBe(1);

		expect(setConvexEnvVars).not.toHaveBeenCalled();
		const message = errorSpy.mock.calls.flat().join('\n');
		expect(message).toContain('NOT pushed');
		expect(message).toContain('CONVEX_ADMIN_KEY');
		expect(message).toContain('owlat quickstart');
	});

	it('fails when there is no .env at all', async () => {
		const root = await installWithEnv(null);

		await expect(runPushEnv({ owlatDir: root })).resolves.toBe(1);
		expect(setConvexEnvVars).not.toHaveBeenCalled();
	});

	it('reports a failed push instead of claiming success', async () => {
		const root = await installWithEnv(`CONVEX_ADMIN_KEY=${ADMIN_KEY}\nEMAIL_PROVIDER=ses\n`);
		setConvexEnvVars.mockRejectedValueOnce(new Error('Failed to set Convex env vars (exit 1).'));

		await expect(runPushEnv({ owlatDir: root })).resolves.toBe(1);
		expect(errorSpy.mock.calls.flat().join('\n')).toContain('Failed to set Convex env vars');
		expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Pushed');
	});
});
