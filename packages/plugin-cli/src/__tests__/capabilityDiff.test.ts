import type { PluginPackageName } from '@owlat/plugin-host';
import { afterEach, describe, expect, it } from 'vitest';
import { computeCapabilityDiff } from '../capabilityDiff';
import { formatCapabilityDiff } from '../report';
import { cleanupCliWorkspaces, createCliWorkspace, manifestModule } from './fixtures';

afterEach(async () => {
	await cleanupCliWorkspaces();
});

function names(values: readonly string[]): readonly PluginPackageName[] {
	return values as readonly PluginPackageName[];
}

const readerA = manifestModule({ id: 'reader-a', version: '1.0.0', capabilities: ['mail:read'] });
const readerB = manifestModule({ id: 'reader-b', version: '1.0.0', capabilities: ['mail:read'] });

describe('computeCapabilityDiff', () => {
	it('does not report a capability as gained when another plugin already declares it', async () => {
		const root = await createCliWorkspace({
			modules: { 'reader-a': readerA, 'reader-b': readerB },
		});

		const diff = await computeCapabilityDiff(
			root,
			names(['reader-a']),
			names(['reader-a', 'reader-b'])
		);

		expect(diff.addedPlugins.map((plugin) => plugin.id)).toEqual(['reader-b']);
		expect(diff.addedCapabilities).toEqual([]);
		expect(diff.removedCapabilities).toEqual([]);
	});

	it('reports a capability as dropped only when no remaining plugin declares it', async () => {
		const root = await createCliWorkspace({
			modules: { 'reader-a': readerA, 'reader-b': readerB },
		});

		const diff = await computeCapabilityDiff(
			root,
			names(['reader-a', 'reader-b']),
			names(['reader-a'])
		);

		expect(diff.removedPlugins.map((plugin) => plugin.id)).toEqual(['reader-b']);
		expect(diff.removedCapabilities).toEqual([]);
		expect(formatCapabilityDiff(diff).join('\n')).toContain(
			'No net change to the requestable capability set.'
		);
	});
});

describe('formatCapabilityDiff', () => {
	it('degrades gracefully when the current set cannot be analyzed', () => {
		const lines = formatCapabilityDiff({
			before: [],
			after: [
				{ packageName: 'kept' as PluginPackageName, id: 'kept', capabilities: ['mail:read'] },
			],
			addedPlugins: [],
			removedPlugins: [],
			addedCapabilities: [],
			removedCapabilities: [],
			beforeUnavailableReason: 'boom',
		});
		const text = lines.join('\n');
		expect(text).toContain('Could not analyze the current bundled set: boom');
		expect(text).toContain('* kept (kept)');
	});
});
