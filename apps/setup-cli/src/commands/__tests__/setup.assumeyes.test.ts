import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression test for `headless-assumeyes`: the documented headless install
 * (`OWLAT_ASSUME_YES=1 curl … | bash`) used to HANG because the terminal wizard
 * still issued interactive clack prompts that never resolve in a non-TTY. The
 * fix routes `--assume-yes` through `buildAssumeYesConfig` (defaults + env) and
 * `buildSetupFromConfig`, with no prompt.
 *
 * Every clack PROMPT is mocked to throw, so if any prompt is ever invoked the
 * thrown error fails the test (in addition to the explicit `not.toHaveBeenCalled`
 * assertions). The non-prompt helpers (`intro`/`outro`/`log`/`isCancel`) are
 * harmless stubs. `saveFlagState` is stubbed because it uses the Bun runtime,
 * which is unavailable under the vitest/node environment.
 */

vi.mock('@clack/prompts', () => {
	const promptThrew = (name: string) =>
		vi.fn(() => {
			throw new Error(`interactive ${name}() prompt was invoked in assumeYes mode`);
		});
	return {
		intro: vi.fn(),
		outro: vi.fn(),
		log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
		isCancel: vi.fn(() => false),
		select: promptThrew('select'),
		multiselect: promptThrew('multiselect'),
		text: promptThrew('text'),
		password: promptThrew('password'),
		confirm: promptThrew('confirm'),
		group: promptThrew('group'),
	};
});

vi.mock('../../lib/flagState', () => ({
	saveFlagState: vi.fn(async () => {}),
}));

import * as clack from '@clack/prompts';
import { saveFlagState } from '../../lib/flagState';
import { runSetup } from '../setup';
import { buildAssumeYesConfig } from '../setupNonInteractive';
import { parseSetupConfig } from '../../lib/setupConfig';
import { readEnv } from '../../lib/env';

const ENV_KEYS = [
	'OWLAT_DEPLOYMENT_MODE',
	'OWLAT_ADMIN_EMAIL',
	'OWLAT_ADMIN_NAME',
	'OWLAT_ADMIN_PASSWORD',
	'EMAIL_PROVIDER',
	'RESEND_API_KEY',
	'AWS_SES_REGION',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
	'LLM_PROVIDER',
	'LLM_API_KEY',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	vi.clearAllMocks();
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

function noPromptCalled() {
	expect(clack.select).not.toHaveBeenCalled();
	expect(clack.multiselect).not.toHaveBeenCalled();
	expect(clack.text).not.toHaveBeenCalled();
	expect(clack.password).not.toHaveBeenCalled();
	expect(clack.confirm).not.toHaveBeenCalled();
	expect(clack.group).not.toHaveBeenCalled();
}

describe('buildAssumeYesConfig', () => {
	it('returns a complete, valid SetupConfig from defaults (selfhost + MTA) with no prompt', () => {
		const config = buildAssumeYesConfig({});

		expect(config.version).toBe(1);
		expect(config.deploymentMode).toBe('selfhost');
		expect(config.sending).toEqual({ provider: 'mta' });
		expect(config.admin).toEqual({ email: 'dev@example.com', name: 'Dev Admin', password: 'devpassword12345' });

		// The default-feature pack enables campaigns/transactional, so a delivery
		// provider is mandatory — `parseSetupConfig` re-validates that invariant and
		// every field shape, proving the produced config is genuinely deployable.
		expect(() => parseSetupConfig(config)).not.toThrow();
		noPromptCalled();
	});

	it('honors OWLAT_DEPLOYMENT_MODE and OWLAT_ADMIN_* overrides from the environment', () => {
		process.env['OWLAT_DEPLOYMENT_MODE'] = 'dev';
		process.env['OWLAT_ADMIN_EMAIL'] = 'ops@acme.test';
		process.env['OWLAT_ADMIN_NAME'] = 'Ops';
		process.env['OWLAT_ADMIN_PASSWORD'] = 'correct horse battery staple';

		const config = buildAssumeYesConfig({});
		expect(config.deploymentMode).toBe('dev');
		expect(config.admin.email).toBe('ops@acme.test');
		expect(config.admin.name).toBe('Ops');
		expect(config.admin.password).toBe('correct horse battery staple');
		noPromptCalled();
	});

	it('selects a Resend provider when its key is present, else falls back to MTA', () => {
		process.env['EMAIL_PROVIDER'] = 'resend';
		process.env['RESEND_API_KEY'] = 're_test_key';
		expect(buildAssumeYesConfig({}).sending).toEqual({ provider: 'resend', apiKey: 're_test_key' });

		// Provider named but credential missing → safe MTA default, never a prompt.
		delete process.env['RESEND_API_KEY'];
		expect(buildAssumeYesConfig({}).sending).toEqual({ provider: 'mta' });
		noPromptCalled();
	});

	it('reads a provider already persisted in the existing .env on a re-run', () => {
		const config = buildAssumeYesConfig({ EMAIL_PROVIDER: 'mta', OWLAT_DEPLOYMENT_MODE: 'selfhost' });
		expect(config.sending).toEqual({ provider: 'mta' });
		expect(config.deploymentMode).toBe('selfhost');
	});

	it('wires an AI provider only when fully specified in the environment', () => {
		expect(buildAssumeYesConfig({}).ai).toBeUndefined();

		process.env['LLM_PROVIDER'] = 'openrouter';
		process.env['LLM_API_KEY'] = 'sk-or-test';
		expect(buildAssumeYesConfig({}).ai).toEqual({ provider: 'openrouter', apiKey: 'sk-or-test' });
	});
});

describe('runSetup --assume-yes', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'owlat-assumeyes-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const opts = (owlatDir: string) => ({
		web: false,
		terminal: true,
		assumeYes: true,
		owlatDir,
		positional: [] as string[],
	});

	it('completes without invoking any prompt and writes a deployable .env', async () => {
		const code = await runSetup(opts(dir));

		expect(code).toBe(0);
		noPromptCalled();
		expect(saveFlagState).toHaveBeenCalledTimes(1);

		const env = await readEnv(join(dir, '.env'));
		expect(env['EMAIL_PROVIDER']).toBe('mta');
		expect(env['OWLAT_DEPLOYMENT_MODE']).toBe('selfhost');
		// Generated secrets + deployment defaults are present, i.e. the produced
		// config is genuinely deployable, not just prompt-free.
		expect(env['INSTANCE_SECRET']).toBeTruthy();
		expect(env['SITE_URL']).toBe('http://localhost:3000');
		expect(env['COMPOSE_PROFILES']).toBeDefined();
	});
});
