import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeComposeOverride } from '../override';

/**
 * The built-in MTA is opt-in: its `mta` compose profile must activate when it's
 * the delivery provider (EMAIL_PROVIDER, read from the co-located .env) or when
 * postbox/inbox need it. This is the glue that makes post-setup flag toggles
 * keep the MTA running for an MTA deployment — exercised here against a real .env.
 */
describe('writeComposeOverride — MTA profile activation from .env', () => {
	const dirs: string[] = [];

	async function tmpWithEnv(envContents: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'owlat-override-'));
		dirs.push(dir);
		await writeFile(join(dir, '.env'), envContents, 'utf-8');
		return dir;
	}

	afterEach(async () => {
		for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
	});

	it('reads EMAIL_PROVIDER=mta from the co-located .env and activates the mta profile', async () => {
		const dir = await tmpWithEnv('EMAIL_PROVIDER=mta\n');
		const profiles = await writeComposeOverride(join(dir, 'docker-compose.override.yml'), { campaigns: true });
		expect(profiles).toContain('mta');
	});

	it('does NOT activate mta for a resend deployment with no MTA-needing flag', async () => {
		const dir = await tmpWithEnv('EMAIL_PROVIDER=resend\n');
		const profiles = await writeComposeOverride(join(dir, 'docker-compose.override.yml'), {
			campaigns: true,
			inbox: false,
			postbox: false,
		});
		expect(profiles).not.toContain('mta');
	});

	it('activates mta for inbox even on a resend deployment (inbound needs it)', async () => {
		const dir = await tmpWithEnv('EMAIL_PROVIDER=resend\n');
		const profiles = await writeComposeOverride(join(dir, 'docker-compose.override.yml'), { inbox: true });
		expect(profiles).toContain('mta');
	});

	it('explicit opts.deliveryProvider overrides the .env value', async () => {
		const dir = await tmpWithEnv('EMAIL_PROVIDER=resend\n');
		const profiles = await writeComposeOverride(
			join(dir, 'docker-compose.override.yml'),
			{ campaigns: true },
			{ deliveryProvider: 'mta' },
		);
		expect(profiles).toContain('mta');
	});

	it('handles a quoted EMAIL_PROVIDER value', async () => {
		const dir = await tmpWithEnv('EMAIL_PROVIDER="mta"\n');
		const profiles = await writeComposeOverride(join(dir, 'docker-compose.override.yml'), { campaigns: true });
		expect(profiles).toContain('mta');
	});

	it('tolerates a missing .env (no mta unless a flag needs it)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'owlat-override-'));
		dirs.push(dir);
		const profiles = await writeComposeOverride(join(dir, 'docker-compose.override.yml'), { campaigns: true });
		expect(profiles).not.toContain('mta');
	});
});
