import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRuntimeEnvVars } from '@owlat/shared/convexRuntimeEnv';
import {
	createEnvBackupBox,
	isEnvBackupSealedValue,
	ENV_BACKUP_SEALED_PREFIX,
} from '@owlat/shared/envBackupBox';
import { readEnvFile, writeEnvFile } from '@owlat/shared/setupEnv';

/**
 * Secrets-at-rest coverage for the CLI setup writers (the `--config`
 * non-interactive install). Card acceptance reads on the `.env` FILE: after an
 * install that configures an SMTP relay, the backup must carry the relay
 * password SEALED (an `envsealed:v1:…` token), never plaintext — while the
 * deploy-time reseed (`selectRuntimeEnvVars`) still unseals it to the working
 * plaintext the live env store receives.
 *
 * `saveFlagState` is stubbed because it uses the Bun runtime, unavailable under
 * vitest/node; `@clack/prompts` `log` is a harmless stub.
 */

vi.mock('../../lib/flagState', () => ({
	saveFlagState: vi.fn(async () => {}),
}));

vi.mock('@clack/prompts', () => ({
	log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { applyConfigFile } from '../setupNonInteractive';
import { runEnv } from '../env';

const RELAY_PASSWORD = 'hunter2-relay-password';

function smtpConfig(): Record<string, unknown> {
	return {
		version: 1,
		deploymentMode: 'selfhost',
		features: {},
		sending: {
			provider: 'smtp',
			host: 'smtp.example.com',
			username: 'postmaster@example.com',
			password: RELAY_PASSWORD,
		},
		admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
	};
}

describe('applyConfigFile — SMTP relay password at rest', () => {
	let dir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		dir = mkdtempSync(join(tmpdir(), 'owlat-secrets-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function runInstall(): Promise<Record<string, string>> {
		const configFile = join(dir, 'setup.json');
		writeFileSync(configFile, JSON.stringify(smtpConfig()));
		const code = await applyConfigFile({
			configFile,
			owlatDir: dir,
			envPath: join(dir, '.env'),
			overridePath: join(dir, 'docker-compose.override.yml'),
		});
		expect(code).toBe(0);
		// Re-parse the written file rather than trust an in-memory map — the
		// acceptance is about what lands on disk.
		const { readEnvFile } = await import('@owlat/shared/setupEnv');
		return readEnvFile(join(dir, '.env'));
	}

	it('writes the relay password SEALED to the .env backup, never plaintext', async () => {
		const env = await runInstall();

		const stored = env['SMTP_RELAY_PASSWORD']!;
		expect(isEnvBackupSealedValue(stored)).toBe(true);
		expect(env['EMAIL_PROVIDER']).toBe('smtp');
		// No plaintext anywhere in the file.
		expect(JSON.stringify(env)).not.toContain(RELAY_PASSWORD);
		// Non-secret transport keys stay readable plaintext.
		expect(env['SMTP_RELAY_HOST']).toBe('smtp.example.com');
		expect(env['SMTP_RELAY_USERNAME']).toBe('postmaster@example.com');
	});

	it('the sealed token round-trips to the exact password under the file INSTANCE_SECRET', async () => {
		const env = await runInstall();

		const instanceSecret = env['INSTANCE_SECRET']!;
		expect(instanceSecret).toMatch(/^[0-9a-f]{64}$/);
		expect(createEnvBackupBox(instanceSecret).open(env['SMTP_RELAY_PASSWORD']!)).toBe(
			RELAY_PASSWORD
		);
	});

	it('the deploy-time reseed unseals it, so the live env push still gets the working plaintext', async () => {
		const env = await runInstall();

		const pushMap = Object.fromEntries(selectRuntimeEnvVars(env));
		expect(pushMap['SMTP_RELAY_PASSWORD']).toBe(RELAY_PASSWORD);
	});
});

/**
 * `owlat-setup env SMTP_RELAY_PASSWORD <value>` is a `.env` WRITER too — an
 * operator rotating the relay password from the CLI must not re-introduce a
 * plaintext credential the initial install just sealed. The setter funnels
 * through the same `sealRelayPasswordForBackup` seam.
 */
describe('owlat-setup env — SMTP relay password at rest', () => {
	// Any non-empty INSTANCE_SECRET keys the box; a realistic 64-hex value.
	const INSTANCE_SECRET = 'de'.repeat(32);
	let dir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		// env.ts's setter writes via console.log/error — silence, don't assert on it.
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		dir = mkdtempSync(join(tmpdir(), 'owlat-env-set-'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	async function seedEnv(map: Record<string, string>): Promise<void> {
		await writeEnvFile(join(dir, '.env'), map);
	}

	async function setVar(key: string, value: string): Promise<Record<string, string>> {
		const code = await runEnv({ owlatDir: dir, positional: [key, value] });
		expect(code).toBe(0);
		return readEnvFile(join(dir, '.env'));
	}

	it('seals the relay password so the .env backup never holds it in plaintext', async () => {
		await seedEnv({ INSTANCE_SECRET, EMAIL_PROVIDER: 'smtp' });
		const env = await setVar('SMTP_RELAY_PASSWORD', 'rotated-relay-secret');

		const stored = env['SMTP_RELAY_PASSWORD']!;
		expect(isEnvBackupSealedValue(stored)).toBe(true);
		expect(JSON.stringify(env)).not.toContain('rotated-relay-secret');
		// Round-trips under the file's own INSTANCE_SECRET, and the deploy reseed
		// unseals it to the working plaintext the live env store receives.
		expect(createEnvBackupBox(INSTANCE_SECRET).open(stored)).toBe('rotated-relay-secret');
		expect(Object.fromEntries(selectRuntimeEnvVars(env))['SMTP_RELAY_PASSWORD']).toBe(
			'rotated-relay-secret'
		);
	});

	it('leaves a non-secret transport key plaintext (only the password is sealed)', async () => {
		await seedEnv({ INSTANCE_SECRET });
		const env = await setVar('SMTP_RELAY_HOST', 'smtp.example.com');
		expect(env['SMTP_RELAY_HOST']).toBe('smtp.example.com');
	});

	it('passes the password through when INSTANCE_SECRET is absent (fail-safe, no unopenable token)', async () => {
		await seedEnv({ EMAIL_PROVIDER: 'smtp' });
		const env = await setVar('SMTP_RELAY_PASSWORD', 'bare-env-secret');
		expect(env['SMTP_RELAY_PASSWORD']).toBe('bare-env-secret');
		expect(isEnvBackupSealedValue(env['SMTP_RELAY_PASSWORD']!)).toBe(false);
	});

	it('is idempotent — re-setting an already-sealed token does not double-seal', async () => {
		await seedEnv({ INSTANCE_SECRET, EMAIL_PROVIDER: 'smtp' });
		const first = (await setVar('SMTP_RELAY_PASSWORD', 'once'))['SMTP_RELAY_PASSWORD']!;
		const again = await setVar('SMTP_RELAY_PASSWORD', first);
		expect(again['SMTP_RELAY_PASSWORD']).toBe(first);
		expect(createEnvBackupBox(INSTANCE_SECRET).open(again['SMTP_RELAY_PASSWORD']!)).toBe('once');
	});

	it('the deploy reseed FAILS CLOSED on a tampered token — ciphertext is never pushed as a live credential', async () => {
		await seedEnv({ INSTANCE_SECRET, EMAIL_PROVIDER: 'smtp' });
		const sealed = (await setVar('SMTP_RELAY_PASSWORD', 'tamper-me'))['SMTP_RELAY_PASSWORD']!;

		const parts = sealed.slice(ENV_BACKUP_SEALED_PREFIX.length).split('.');
		const last = parts[parts.length - 1]!;
		parts[parts.length - 1] = (last[0] === 'A' ? 'B' : 'A') + last.slice(1);
		const tampered = ENV_BACKUP_SEALED_PREFIX + parts.join('.');

		expect(() => selectRuntimeEnvVars({ INSTANCE_SECRET, SMTP_RELAY_PASSWORD: tampered })).toThrow(
			/SMTP_RELAY_PASSWORD/
		);
	});
});
