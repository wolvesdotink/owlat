import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { computeEnvShowRows, isSecretKey, maskSecretValue, runEnv } from '../env';
import { cliOptionsFromArgv } from '../../lib/argv';
import { readEnv } from '../../lib/env';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';

/**
 * `computeEnvShowRows` is the pure decision behind `owlat-setup env --show`: it
 * turns a stored flag state + a deployment env map into the list of required
 * vars (each with set/value/requiredBy). It is unit-tested directly because
 * `runEnvShow` reads the filesystem via the Bun runtime, which is unavailable
 * under the vitest/node test environment.
 */
describe('env — maskSecretValue / isSecretKey', () => {
	it('masks *_KEY / *_SECRET / *_PASSWORD values and leaves others verbatim', () => {
		expect(isSecretKey('LLM_API_KEY')).toBe(true);
		expect(isSecretKey('MTA_API_SECRET')).toBe(true);
		expect(isSecretKey('REDIS_PASSWORD')).toBe(true);
		expect(isSecretKey('POSTHOG_HOST')).toBe(false);

		// A secret value never appears in its masked form.
		expect(maskSecretValue('LLM_API_KEY', 'sk-supersecret')).not.toContain('supersecret');
		expect(maskSecretValue('LLM_API_KEY', 'sk-supersecret')).toMatch(/^\*+…$/);
		// Non-secret values pass through untouched.
		expect(maskSecretValue('POSTHOG_HOST', 'https://ph.example')).toBe('https://ph.example');
	});
});

describe('env — computeEnvShowRows', () => {
	it('masks a secret required key but keeps the row marked as set', () => {
		// scan.urls requires GOOGLE_SAFE_BROWSING_API_KEY (a *_KEY secret).
		const rows = computeEnvShowRows(
			{ 'scan.urls': true },
			{ GOOGLE_SAFE_BROWSING_API_KEY: 'gsb-rawsecretvalue' }
		);
		const row = rows.find((r) => r.key === 'GOOGLE_SAFE_BROWSING_API_KEY');
		expect(row?.set).toBe(true);
		expect(row?.masked).not.toContain('rawsecret');
		expect(row?.masked).toMatch(/^\*+…$/);
		expect(row?.requiredBy).toContain('scan.urls');
	});

	it('flags an unset required key with "(unset)" and set=false', () => {
		// ai requires LLM_PROVIDER + LLM_API_KEY; pass an empty env so both are absent.
		const rows = computeEnvShowRows({ ai: true }, {});
		expect(rows.map((r) => r.key).sort()).toEqual(['LLM_API_KEY', 'LLM_PROVIDER']);
		expect(rows.every((r) => !r.set)).toBe(true);
		expect(rows.find((r) => r.key === 'LLM_API_KEY')?.masked).toBe('(unset)');
	});

	it('treats an empty-string value as unset', () => {
		const rows = computeEnvShowRows({ ai: true }, { LLM_PROVIDER: '', LLM_API_KEY: 'x' });
		expect(rows.find((r) => r.key === 'LLM_PROVIDER')?.set).toBe(false);
		expect(rows.find((r) => r.key === 'LLM_API_KEY')?.set).toBe(true);
	});

	it('shows a non-secret value verbatim and attributes it to the requiring flag', () => {
		const rows = computeEnvShowRows(
			{ 'analytics.posthog': true },
			{ POSTHOG_HOST: 'https://ph.example' }
		);
		const host = rows.find((r) => r.key === 'POSTHOG_HOST');
		expect(host?.set).toBe(true);
		expect(host?.masked).toBe('https://ph.example');
		expect(host?.requiredBy).toContain('analytics.posthog');
		// Its sibling secret key is still listed as required-but-unset.
		expect(rows.find((r) => r.key === 'POSTHOG_API_KEY')?.set).toBe(false);
	});

	it('changes the required set when the flag state changes', () => {
		// ai OFF (default) with no provider → nothing required.
		expect(computeEnvShowRows({}, {})).toEqual([]);
		// ai ON → LLM vars become required.
		const withAi = computeEnvShowRows({ ai: true }, {}).map((r) => r.key);
		expect(withAi).toContain('LLM_PROVIDER');
		expect(withAi).toContain('LLM_API_KEY');
	});

	it('folds in (and attributes) the send-path vars only when a provider is given', () => {
		const flags: FeatureFlagState = { campaigns: true };
		// Provider known → MTA send-path vars appear, attributed to the send path.
		const withProvider = computeEnvShowRows(
			flags,
			{ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'mta_rawsecret' },
			{ deliveryProvider: 'mta' }
		);
		const apiKey = withProvider.find((r) => r.key === 'MTA_API_KEY');
		expect(apiKey?.requiredBy).toContain('send path');
		expect(apiKey?.masked).not.toContain('rawsecret');
		const url = withProvider.find((r) => r.key === 'MTA_API_URL');
		expect(url?.set).toBe(true);
		expect(url?.masked).toBe('http://mta:3100'); // not a secret key → verbatim

		// No provider → the conditional send-path vars are not folded in.
		const withoutProvider = computeEnvShowRows(flags, {}).map((r) => r.key);
		expect(withoutProvider).not.toContain('MTA_API_URL');
		expect(withoutProvider).not.toContain('MTA_API_KEY');
	});
});

describe('owlat-setup env <KEY> <VALUE> with --owlat-dir', () => {
	const roots: string[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	// The argv tail as the dispatcher parses it, so an option value that leaked
	// into the positional arguments would end up in the key or the value.
	it.each([
		[
			'after the arguments',
			(dir: string) => ['SITE_URL', 'https://mail.example.com', '--owlat-dir', dir],
		],
		[
			'before the arguments',
			(dir: string) => ['--owlat-dir', dir, 'SITE_URL', 'https://mail.example.com'],
		],
		[
			'as --owlat-dir=<dir>',
			(dir: string) => ['SITE_URL', 'https://mail.example.com', `--owlat-dir=${dir}`],
		],
	])('writes exactly KEY=VALUE into <dir>/.env with the option %s', async (_label, argv) => {
		const root = await mkdtemp(join(tmpdir(), 'owlat-env-'));
		roots.push(root);
		vi.spyOn(console, 'log').mockImplementation(() => undefined);

		await expect(runEnv(cliOptionsFromArgv(argv(root), {}))).resolves.toBe(0);

		expect(await readEnv(join(root, '.env'))).toEqual({
			SITE_URL: 'https://mail.example.com',
		});
	});
});
