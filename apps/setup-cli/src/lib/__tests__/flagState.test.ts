import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAndPersist, applyPackAndPersist, saveFlagState } from '../flagState';

const roots: string[] = [];

beforeEach(() => {
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
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryOwlatDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-flags-'));
	roots.push(root);
	return root;
}

describe('setup CLI flag persistence', () => {
	it('preserves plugin overrides while toggling a core flag', async () => {
		const root = await temporaryOwlatDirectory();
		await saveFlagState(root, { ai: true, 'plugin.policy-pack': false });

		const result = await applyAndPersist(root, 'ai', false);

		expect(result.state['plugin.policy-pack']).toBe(false);
		expect(JSON.parse(await readFile(join(root, '.owlat-flags.json'), 'utf8'))).toMatchObject({
			ai: false,
			'plugin.policy-pack': false,
		});
	});

	it('preserves plugin overrides while toggling a feature pack', async () => {
		const root = await temporaryOwlatDirectory();
		await saveFlagState(root, { inbox: false, 'plugin.policy-pack': true });

		const result = await applyPackAndPersist(root, 'emailClient', true);

		expect(result.state['plugin.policy-pack']).toBe(true);
	});
});
