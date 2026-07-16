import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundledPlugins } from '../packageLoader';
import {
	cleanupPackageLoaderWorkspaces,
	createPackageLoaderWorkspace,
} from './packageLoaderFixtures';

afterEach(cleanupPackageLoaderWorkspaces);

describe('plugin contribution export loading', () => {
	it.each([
		{
			label: 'send transport',
			packageName: 'mail-plugin',
			manifest: `export default { id: 'mail', version: '1.0.0', capabilities: ['send:transport'], flag: { default: false }, contributes: { sendTransports: [{ id: 'postmark', label: 'Postmark', module: { exportPath: './transports/postmark' }, retryDelays: [] }] } };`,
			exportPath: './transports/postmark',
			filePath: 'transports/postmark.js',
		},
		{
			label: 'agent step',
			packageName: 'agent-plugin',
			manifest: `export default { id: 'agent', version: '1.0.0', capabilities: ['agent:step'], flag: { default: false }, contributes: { agentSteps: [{ id: 'spam-score', after: 'security_scan', module: { exportPath: './agent/spam-score' }, lifecycleEdges: [{ kind: 'caution', from: 'classifying', to: 'archived' }] }] } };`,
			exportPath: './agent/spam-score',
			filePath: 'agent/spam-score.js',
		},
		{
			label: 'draft strategy',
			packageName: 'draft-plugin',
			manifest: `export default { id: 'draft', version: '1.0.0', capabilities: ['draft:strategy'], flag: { default: false }, contributes: { draftStrategies: [{ id: 'legal', label: 'Legal', module: { exportPath: './draft/legal' }, timeoutMs: 1000 }] } };`,
			exportPath: './draft/legal',
			filePath: 'draft/legal.js',
		},
	] as const)('verifies $label exports without executing them', async (fixture) => {
		const root = await createPackageLoaderWorkspace(
			{ [fixture.packageName]: '1.0.0' },
			{
				[fixture.packageName]: {
					source: fixture.manifest,
					packageJson: {
						exports: {
							'.': './index.js',
							[fixture.exportPath]: `./${fixture.filePath}`,
						},
					},
					files: {
						[fixture.filePath]: `throw new Error('codegen must not execute contribution modules'); export default {};`,
					},
				},
			}
		);

		await expect(loadBundledPlugins(root, [fixture.packageName])).resolves.toHaveLength(1);
		await writeFile(
			join(root, `node_modules/${fixture.packageName}/package.json`),
			JSON.stringify({
				name: fixture.packageName,
				version: '1.0.0',
				type: 'module',
				exports: { '.': './index.js' },
			})
		);
		await expect(loadBundledPlugins(root, [fixture.packageName])).rejects.toMatchObject({
			code: 'contribution_export_invalid',
		});
	});
});
