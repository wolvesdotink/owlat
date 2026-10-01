import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type * as ConvexDeploy from '../../lib/convexDeploy';
import type * as EnvLib from '../../lib/env';

const { removeConvexEnvVars, failEnvWrite } = vi.hoisted(() => ({
	removeConvexEnvVars: vi.fn(),
	failEnvWrite: { on: false },
}));

// Only the docker-driven removal is faked; the catalog check, the admin-key
// check and the .env read/write are the real ones.
vi.mock('../../lib/convexDeploy', async (importOriginal) => ({
	...(await importOriginal<typeof ConvexDeploy>()),
	removeConvexEnvVars,
}));
vi.mock('../../lib/env', async (importOriginal) => {
	const actual = await importOriginal<typeof EnvLib>();
	return {
		...actual,
		writeEnv: async (...args: Parameters<typeof actual.writeEnv>) => {
			if (failEnvWrite.on) throw new Error('EACCES: permission denied');
			return actual.writeEnv(...args);
		},
	};
});

import { ConvexEnvRemoveError } from '../../lib/convexDeploy';
import { derivedRuntimeKeys, runUnsetEnv, unsetEnvRefusal } from '../unsetEnv';

const ADMIN_KEY = 'convex-self-hosted|0123456789abcdef0123456789abcdef';
const roots: string[] = [];
let logSpy: MockInstance;
let errorSpy: MockInstance;

async function installWithEnv(env: string | null): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-unset-env-'));
	roots.push(root);
	if (env !== null) await writeFile(join(root, '.env'), env);
	return root;
}

const readDotEnv = (root: string) => readFile(join(root, '.env'), 'utf-8');
const errors = () => errorSpy.mock.calls.flat().join('\n');

describe('owlat-setup unset-env', () => {
	beforeEach(() => {
		removeConvexEnvVars.mockReset();
		removeConvexEnvVars.mockResolvedValue(undefined);
		failEnvWrite.on = false;
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it('clears a provider URL from the deployment and from .env', async () => {
		const root = await installWithEnv(
			[
				`CONVEX_ADMIN_KEY=${ADMIN_KEY}`,
				'LLM_PROVIDER=openai',
				'LLM_BASE_URL=https://old-provider.example/v1',
				'EMAIL_PROVIDER=mta',
			].join('\n')
		);

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL'] })).resolves.toBe(0);

		expect(removeConvexEnvVars).toHaveBeenCalledTimes(1);
		expect(removeConvexEnvVars.mock.calls[0]!.slice(0, 2)).toEqual([root, ['LLM_BASE_URL']]);
		const dotEnv = await readDotEnv(root);
		expect(dotEnv).not.toContain('LLM_BASE_URL');
		expect(dotEnv).toContain('LLM_PROVIDER=openai');
		expect(dotEnv).toContain('EMAIL_PROVIDER=mta');
		expect(dotEnv).toContain(`CONVEX_ADMIN_KEY=${ADMIN_KEY}`);
		expect(logSpy.mock.calls.flat().join('\n')).toContain(
			'Unset LLM_BASE_URL in the Convex deployment and .env'
		);
	});

	it('clears a key that .env only holds blank, which apply would skip', async () => {
		const root = await installWithEnv(`CONVEX_ADMIN_KEY=${ADMIN_KEY}\nLLM_BASE_URL=\n`);

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL'] })).resolves.toBe(0);

		expect(removeConvexEnvVars.mock.calls[0]![1]).toEqual(['LLM_BASE_URL']);
		expect(await readDotEnv(root)).not.toContain('LLM_BASE_URL');
	});

	it('clears an optional override the deployment holds but .env does not', async () => {
		// Set by hand with `convex env set` (or by the in-app editor), never in .env.
		const original = `CONVEX_ADMIN_KEY=${ADMIN_KEY}\nEMAIL_PROVIDER=mta\n`;
		const root = await installWithEnv(original);

		await expect(
			runUnsetEnv({
				owlatDir: root,
				positional: ['LOCAL_EMBEDDING_BASE_URL', 'AI_SPEND_DAILY_BUDGET_USD'],
			})
		).resolves.toBe(0);

		expect(removeConvexEnvVars.mock.calls[0]![1]).toEqual([
			'LOCAL_EMBEDDING_BASE_URL',
			'AI_SPEND_DAILY_BUDGET_USD',
		]);
		// Nothing to drop from .env, so the file is not rewritten.
		expect(await readDotEnv(root)).toBe(original);
		expect(logSpy.mock.calls.flat().join('\n')).toContain('in the Convex deployment.');
	});

	it.each([
		['a compose-only key', 'EHLO_HOSTNAMES', 'not one of the Convex function-runtime keys'],
		['a named transport instance key', 'SMTP_RELAY_HOST__BACKUP', 'Named transport instances'],
		['a plugin variable', 'PLUGIN_ACME_TOKEN', 'plugin (PLUGIN_*) variables'],
		['a lowercase name', 'llm_base_url', 'not one of the Convex function-runtime keys'],
		['a key every install needs', 'INSTANCE_SECRET', 'required by every install'],
	])('refuses %s and changes nothing', async (_label, key, reason) => {
		const original = `CONVEX_ADMIN_KEY=${ADMIN_KEY}\n${key}=value\nLLM_BASE_URL=https://old.example/v1\n`;
		const root = await installWithEnv(original);

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL', key] })).resolves.toBe(
			1
		);

		expect(removeConvexEnvVars).not.toHaveBeenCalled();
		expect(await readDotEnv(root)).toBe(original);
		expect(errors()).toContain(reason);
		expect(errors()).toContain('Nothing was changed');
	});

	it('refuses an MTA key that .env derives from another setting', async () => {
		const original = [
			`CONVEX_ADMIN_KEY=${ADMIN_KEY}`,
			'IP_POOLS_TRANSACTIONAL=203.0.113.10',
			'MTA_IP_POOLS=203.0.113.10',
		].join('\n');
		const root = await installWithEnv(original);

		await expect(runUnsetEnv({ owlatDir: root, positional: ['MTA_IP_POOLS'] })).resolves.toBe(1);

		expect(removeConvexEnvVars).not.toHaveBeenCalled();
		expect(await readDotEnv(root)).toBe(original);
		expect(errors()).toContain('derived from other settings in .env');
	});

	it('says why nothing changed when .env has no admin key', async () => {
		const original = 'LLM_BASE_URL=https://old.example/v1\n';
		const root = await installWithEnv(original);

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL'] })).resolves.toBe(1);

		expect(removeConvexEnvVars).not.toHaveBeenCalled();
		expect(await readDotEnv(root)).toBe(original);
		expect(errors()).toContain('Nothing was changed');
		expect(errors()).toContain('CONVEX_ADMIN_KEY');
	});

	it('fails when there is no .env at all', async () => {
		const root = await installWithEnv(null);

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL'] })).resolves.toBe(1);
		expect(removeConvexEnvVars).not.toHaveBeenCalled();
	});

	it('prints usage without a key', async () => {
		const root = await installWithEnv(`CONVEX_ADMIN_KEY=${ADMIN_KEY}\n`);

		await expect(runUnsetEnv({ owlatDir: root, positional: [] })).resolves.toBe(1);
		expect(errors()).toContain('Usage: owlat-setup unset-env');
	});

	it('leaves .env alone when the backend rejects the removal', async () => {
		const original = `CONVEX_ADMIN_KEY=${ADMIN_KEY}\nLLM_BASE_URL=https://old.example/v1\n`;
		const root = await installWithEnv(original);
		removeConvexEnvVars.mockRejectedValueOnce(
			new ConvexEnvRemoveError('Failed to remove Convex function-runtime env vars (exit 1).', [])
		);

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL'] })).resolves.toBe(1);

		expect(await readDotEnv(root)).toBe(original);
		expect(errors()).toContain('Failed to remove Convex function-runtime env vars');
		expect(errors()).toContain(
			'Not removed (the deployment and .env are unchanged for these): LLM_BASE_URL'
		);
		expect(errors()).toContain('owlat unset-env LLM_BASE_URL');
		expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Unset');
	});

	it('drops from .env only what the deployment confirmed before a failure', async () => {
		const root = await installWithEnv(
			[
				`CONVEX_ADMIN_KEY=${ADMIN_KEY}`,
				'LLM_BASE_URL=https://old.example/v1',
				'DECISION_BASE_URL=https://decide.example/v1',
			].join('\n')
		);
		removeConvexEnvVars.mockRejectedValueOnce(
			new ConvexEnvRemoveError('Failed to remove Convex function-runtime env vars (exit 1).', [
				'LLM_BASE_URL',
			])
		);

		await expect(
			runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL', 'DECISION_BASE_URL'] })
		).resolves.toBe(1);

		const dotEnv = await readDotEnv(root);
		expect(dotEnv).not.toContain('LLM_BASE_URL');
		expect(dotEnv).toContain('DECISION_BASE_URL=https://decide.example/v1');
		expect(errors()).toContain('Removed from the deployment: LLM_BASE_URL');
		expect(errors()).toContain('owlat unset-env DECISION_BASE_URL');
	});

	it('reports a failed .env write after the deployment was cleared', async () => {
		const original = `CONVEX_ADMIN_KEY=${ADMIN_KEY}\nLLM_BASE_URL=https://old.example/v1\n`;
		const root = await installWithEnv(original);
		failEnvWrite.on = true;

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL'] })).resolves.toBe(1);

		expect(removeConvexEnvVars).toHaveBeenCalledTimes(1);
		expect(await readDotEnv(root)).toBe(original);
		expect(errors()).toContain('could not update .env');
		expect(errors()).toContain('would push it back');
	});

	it('lets an unexpected error propagate', async () => {
		const root = await installWithEnv(`CONVEX_ADMIN_KEY=${ADMIN_KEY}\n`);
		removeConvexEnvVars.mockRejectedValueOnce(new TypeError('boom'));

		await expect(runUnsetEnv({ owlatDir: root, positional: ['LLM_BASE_URL'] })).rejects.toThrow(
			'boom'
		);
	});
});

describe('unsetEnvRefusal', () => {
	it('allows every runtime key except the ones every install needs', () => {
		expect(unsetEnvRefusal('LLM_BASE_URL')).toBeNull();
		expect(unsetEnvRefusal('INSTANCE_SECRET_PREVIOUS')).toBeNull();
		expect(unsetEnvRefusal('SEND_TRANSPORT_INSTANCES')).toBeNull();
		for (const key of ['BETTER_AUTH_SECRET', 'INSTANCE_SECRET', 'SITE_URL']) {
			expect(unsetEnvRefusal(key)).toContain('required by every install');
		}
	});
});

describe('derivedRuntimeKeys', () => {
	it('names a key push-env would still derive once it is gone from .env', () => {
		const env = { RETURN_PATH_DOMAIN: 'bounce.example.com', MTA_RETURN_PATH_DOMAIN: 'x' };
		expect(derivedRuntimeKeys(env, ['MTA_RETURN_PATH_DOMAIN', 'LLM_BASE_URL'])).toEqual([
			'MTA_RETURN_PATH_DOMAIN',
		]);
	});

	it('lets a key go when its source setting is absent too', () => {
		expect(derivedRuntimeKeys({ MTA_IP_POOLS: '203.0.113.10' }, ['MTA_IP_POOLS'])).toEqual([]);
	});
});
