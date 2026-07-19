import type { CapabilityDiff, PluginCapabilitySummary } from './capabilityDiff';

/**
 * Render a capability diff as human-readable lines. The diff is the operator's
 * decision surface: it names every plugin entering or leaving the bundle and,
 * separately, the capabilities the composition gains or loses overall, so an
 * operator can see exactly which host-mediated powers a change would unlock
 * before committing to it.
 */
export function formatCapabilityDiff(diff: CapabilityDiff): readonly string[] {
	const lines: string[] = ['Capability diff:'];

	if (diff.beforeUnavailableReason !== undefined) {
		lines.push(
			`  Could not analyze the current bundled set: ${diff.beforeUnavailableReason}`,
			'  Showing the resulting composition only.',
			'',
			'Resulting bundled plugins:'
		);
		if (diff.after.length === 0) lines.push('  (none)');
		for (const plugin of diff.after) lines.push(...formatPluginLines('*', plugin));
		return lines;
	}

	if (diff.addedPlugins.length === 0 && diff.removedPlugins.length === 0) {
		lines.push('  No bundled plugins change.');
	}
	for (const plugin of diff.addedPlugins) lines.push(...formatPluginLines('+', plugin));
	for (const plugin of diff.removedPlugins) lines.push(...formatPluginLines('-', plugin));

	lines.push('', 'Capabilities requestable by the composition:');
	lines.push(...formatCapabilityChange('+ gained', diff.addedCapabilities));
	lines.push(...formatCapabilityChange('- dropped', diff.removedCapabilities));
	if (diff.addedCapabilities.length === 0 && diff.removedCapabilities.length === 0) {
		lines.push('  No net change to the requestable capability set.');
	}
	return lines;
}

function formatPluginLines(
	marker: '+' | '-' | '*',
	plugin: PluginCapabilitySummary
): readonly string[] {
	const header = `  ${marker} ${plugin.packageName} (${plugin.id})`;
	if (plugin.capabilities.length === 0) return [`${header} — declares no capabilities`];
	return [`${header} declares:`, ...plugin.capabilities.map((capability) => `      ${capability}`)];
}

function formatCapabilityChange(label: string, capabilities: readonly string[]): readonly string[] {
	return capabilities.map((capability) => `  ${label}: ${capability}`);
}
