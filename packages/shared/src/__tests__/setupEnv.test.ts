import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEnvFile, writeEnvFile } from '../setupEnv';

describe('writeEnvFile', () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'owlat-env-'));
		path = join(dir, '.env');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('rejects a value containing a newline instead of emitting a physical multi-line value', async () => {
		// A newline pushed through an allowlisted key (e.g. DEFAULT_FROM_NAME) would
		// otherwise inject an arbitrary extra `.env` line the operator never set.
		await expect(
			writeEnvFile(path, { DEFAULT_FROM_NAME: 'Acme\nINSTANCE_SECRET=attacker-owned' })
		).rejects.toThrow(/newline, carriage return, or NUL/);
	});

	it.each([
		['carriage return', 'Acme\rINSTANCE_SECRET=x'],
		['NUL', 'Acme\0x'],
	])('rejects a value containing a %s', async (_label, value) => {
		await expect(writeEnvFile(path, { DEFAULT_FROM_NAME: value })).rejects.toThrow();
	});

	it('never emits a physical multi-line value: every written line round-trips to one key', async () => {
		await writeEnvFile(path, {
			EMAIL_PROVIDER: 'resend',
			DEFAULT_FROM_NAME: 'Acme Mailer',
			RESEND_API_KEY: 're_test_123',
		});
		const raw = await readFile(path, 'utf-8');
		// No emitted value line may itself contain a bare newline in its content: the
		// only newlines in the file are the line separators the writer controls.
		const valueLines = raw.split('\n').filter((l) => l && !l.startsWith('#'));
		expect(valueLines).toHaveLength(3);
		// And the file reconstructs exactly the map it was handed — no injected keys.
		const roundTripped = await readEnvFile(path);
		expect(roundTripped).toMatchObject({
			EMAIL_PROVIDER: 'resend',
			DEFAULT_FROM_NAME: 'Acme Mailer',
			RESEND_API_KEY: 're_test_123',
		});
		expect(roundTripped).not.toHaveProperty('INSTANCE_SECRET');
	});
});
