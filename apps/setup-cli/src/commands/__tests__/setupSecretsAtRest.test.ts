import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRuntimeEnvVars } from '@owlat/shared/convexRuntimeEnv';
import { createEnvBackupBox, isEnvBackupSealedValue } from '@owlat/shared/envBackupBox';

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
