import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createEnvBackupBox, isEnvBackupSealedValue } from '@owlat/shared/envBackupBox';
import { getDefaultFlags } from '@owlat/shared/featureFlags';
import { readEnvFile } from '@owlat/shared/setupEnv';
import { persistResolvedSetup } from '../persistSetup';

/**
 * The write half shared by the interactive wizard, `--config` and
 * `--assume-yes`. Assertions read the files back from disk: what matters is
 * what lands there, not the in-memory maps.
 */

const RELAY_PASSWORD = 'hunter2-relay-password';
const INSTANCE_SECRET = 'de'.repeat(32);

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'owlat-persist-'));
	// saveFlagState writes through the Bun runtime, which vitest/node lacks.
	vi.stubGlobal('Bun', {
		file: (path: string) => ({
			exists: async () =>
				stat(path)
					.then(() => true)
					.catch(() => false),
			text: async () => readFile(path, 'utf8'),
		}),
		write: (path: string, contents: string) => writeFile(path, contents),
	});
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(dir, { recursive: true, force: true });
});

async function persist(env: Record<string, string>) {
	const flags = getDefaultFlags({ hosted: false });
	const paths = {
		owlatDir: dir,
		envPath: join(dir, '.env'),
		overridePath: join(dir, 'docker-compose.override.yml'),
	};
	const profiles = await persistResolvedSetup({ ...paths, env, flags, hosted: false });
	return {
		flags,
		profiles,
		env: await readEnvFile(paths.envPath),
		override: await readFile(paths.overridePath, 'utf-8'),
		flagFile: JSON.parse(await readFile(join(dir, '.owlat-flags.json'), 'utf-8')),
	};
}

describe('persistResolvedSetup', () => {
	it('never writes the SMTP relay password to .env in plaintext', async () => {
		const { env } = await persist({
			INSTANCE_SECRET,
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'smtp.example.com',
			SMTP_RELAY_USERNAME: 'postmaster@example.com',
			SMTP_RELAY_PASSWORD: RELAY_PASSWORD,
		});

		const stored = env['SMTP_RELAY_PASSWORD']!;
		expect(isEnvBackupSealedValue(stored)).toBe(true);
		expect(JSON.stringify(env)).not.toContain(RELAY_PASSWORD);
		expect(createEnvBackupBox(INSTANCE_SECRET).open(stored)).toBe(RELAY_PASSWORD);
		expect(env['SMTP_RELAY_HOST']).toBe('smtp.example.com');
	});

	it('returns the override profiles and writes them to COMPOSE_PROFILES', async () => {
		const { profiles, env, override } = await persist({ INSTANCE_SECRET, EMAIL_PROVIDER: 'mta' });

		// The override reads EMAIL_PROVIDER from the .env written just before it,
		// so an MTA install gets the opt-in mta profile.
		expect(profiles).toContain('mta');
		expect(parseYaml(override)['x-owlat-profiles']).toEqual(profiles);
		expect(env['COMPOSE_PROFILES']).toBe(profiles.join(','));
	});

	it('mirrors the resolved flags to .owlat-flags.json', async () => {
		const { flags, flagFile } = await persist({ INSTANCE_SECRET });

		expect(flagFile).toEqual(flags);
	});
});
