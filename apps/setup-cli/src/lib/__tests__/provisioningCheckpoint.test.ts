import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProvisioningCheckpoint, type CheckpointInputs } from '../provisioningCheckpoint';

const dirs: string[] = [];
const inputs: CheckpointInputs = {
	mode: 'populated',
	shouldBootstrap: true,
	shouldSeed: true,
	adminEmail: 'admin@example.com',
	version: '1.2.3',
	buildLocal: false,
	localImages: false,
	composeProfiles: ['mta'],
	sourceRevision: 'abc123',
};

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'owlat-checkpoint-'));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ProvisioningCheckpoint', () => {
	it('resumes completed steps for the same public inputs', async () => {
		const owlatDir = await tempDir();
		const first = await ProvisioningCheckpoint.open({ owlatDir, inputs });
		await first.complete('deploy-functions');

		const resumed = await ProvisioningCheckpoint.open({ owlatDir, inputs });
		expect(resumed.isComplete('deploy-functions')).toBe(true);
		expect(resumed.completedSteps()).toEqual(['deploy-functions']);
	});

	it('starts clean when public provisioning inputs change', async () => {
		const owlatDir = await tempDir();
		const first = await ProvisioningCheckpoint.open({ owlatDir, inputs });
		await first.complete('seed-demo');

		const changed = await ProvisioningCheckpoint.open({
			owlatDir,
			inputs: { ...inputs, shouldSeed: false },
		});
		expect(changed.completedSteps()).toEqual([]);
	});

	it('never writes credentials or passwords to checkpoint state', async () => {
		const owlatDir = await tempDir();
		await ProvisioningCheckpoint.open({ owlatDir, inputs });
		const stored = await readFile(join(owlatDir, '.owlat-provisioning.json'), 'utf-8');
		expect(stored).not.toContain('password');
		expect(stored).not.toContain('secret');
		expect(stored).not.toContain('admin@example.com');
	});

	it('discards progress when restart is requested', async () => {
		const owlatDir = await tempDir();
		const first = await ProvisioningCheckpoint.open({ owlatDir, inputs });
		await first.complete('bootstrap-admin');

		const restarted = await ProvisioningCheckpoint.open({ owlatDir, inputs, restart: true });
		expect(restarted.isComplete('bootstrap-admin')).toBe(false);
	});
});
