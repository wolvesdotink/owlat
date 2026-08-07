/**
 * Provenance for a contribution's SECOND executable half.
 *
 * `packageLoaderExecutableBuckets.test.ts` proves every bucket's own
 * `module.exportPath` is resolved through the installed package's `exports` map
 * and asserted to live inside the package root. A send transport's feedback
 * webhook (the seams plan's D6/P2.2) hangs off `webhook.module.exportPath`
 * instead — one level down — and codegen emits `import … from "<pkg>/<path>"`
 * for it exactly as it does for the send half.
 *
 * If the structural walk that decides what gets verified could not see one level
 * down, that import would reach generated Convex code unverified: a manifest
 * could name a path the package never exported, or one its `exports` map points
 * outside the package — the classic provenance escape — and the only thing
 * standing between that and the HTTP router would be nothing.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginContributionModules } from '@owlat/plugin-kit';
import { loadBundledPlugins } from '../packageLoader';
import {
	cleanupPackageLoaderWorkspaces,
	createPackageLoaderWorkspace,
} from './packageLoaderFixtures';

afterEach(cleanupPackageLoaderWorkspaces);

const PACKAGE_NAME = 'webhook-transport-plugin';
const SEND_EXPORT = './convex/transport';
const WEBHOOK_EXPORT = './convex/webhook';

const MANIFEST = `export default {
	id: 'webhook-pack',
	version: '1.0.0',
	capabilities: ['send:transport'],
	flag: { default: false },
	contributes: {
		sendTransports: [
			{
				id: 'relay',
				label: 'Relay',
				module: { exportPath: '${SEND_EXPORT}' },
				retryDelays: [],
				webhook: {
					module: { exportPath: '${WEBHOOK_EXPORT}' },
					signature: {
						header: 'x-relay-signature',
						algorithm: 'hmac-sha256',
						encoding: 'hex',
						secretEnvVar: 'PLUGIN_RELAY_WEBHOOK_SECRET',
						replay: { timestampHeader: 'x-relay-timestamp', toleranceSeconds: 300 },
					},
				},
			},
		],
	},
};`;

async function workspace(webhookTarget: string): Promise<string> {
	return createPackageLoaderWorkspace(
		{ [PACKAGE_NAME]: '1.0.0' },
		{
			[PACKAGE_NAME]: {
				source: MANIFEST,
				packageJson: {
					exports: {
						'.': './index.js',
						[SEND_EXPORT]: './convex/transport.js',
						[WEBHOOK_EXPORT]: webhookTarget,
					},
				},
				files: {
					'convex/transport.js': `throw new Error('codegen must not execute contribution modules'); export default {};`,
					'convex/webhook.js': `throw new Error('codegen must not execute contribution modules'); export default {};`,
				},
			},
		}
	);
}

describe('a send transport webhook is provenance-verified like any other module', () => {
	it('accepts a well-formed webhook export and reports it as a second half', async () => {
		const root = await workspace('./convex/webhook.js');
		const loaded = await loadBundledPlugins(root, [PACKAGE_NAME]);

		expect(loaded).toHaveLength(1);
		// Both halves are visible to the walk — otherwise the rejection cases below
		// would pass for the wrong reason (a webhook nobody looked at cannot fail).
		expect(pluginContributionModules(loaded[0]!.manifest)).toEqual([
			{ bucket: 'sendTransports', id: 'relay', exportPath: SEND_EXPORT },
			{ bucket: 'sendTransports', id: 'relay', exportPath: WEBHOOK_EXPORT, role: 'webhook' },
		]);
	});

	it('rejects a webhook module that escapes the package root', async () => {
		const root = await workspace('../../escape.js');
		await expect(loadBundledPlugins(root, [PACKAGE_NAME])).rejects.toMatchObject({
			code: 'contribution_export_invalid',
		});
	});

	it('rejects a webhook module the package does not export', async () => {
		const root = await workspace('./convex/webhook.js');
		await writeFile(
			join(root, `node_modules/${PACKAGE_NAME}/package.json`),
			JSON.stringify({
				name: PACKAGE_NAME,
				version: '1.0.0',
				type: 'module',
				exports: { '.': './index.js', [SEND_EXPORT]: './convex/transport.js' },
			})
		);
		await expect(loadBundledPlugins(root, [PACKAGE_NAME])).rejects.toMatchObject({
			code: 'contribution_export_invalid',
		});
	});
});
