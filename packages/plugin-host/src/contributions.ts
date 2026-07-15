import { isPluginId, type PluginId } from '@owlat/plugin-kit';
import { compareCodePoints } from './compareCodePoints';
import { PluginHostError } from './errors';

export interface HostedContribution<Value> {
	readonly pluginId: PluginId;
	readonly contributionId: string;
	readonly value: Value;
}

/**
 * Consumer-neutral ordering for statically composed contributions. Consumer
 * registries remain responsible for their own richer ordering constraints.
 */
export function orderHostedContributions<Value>(
	contributions: readonly HostedContribution<Value>[]
): readonly HostedContribution<Value>[] {
	const contributionIdsByPlugin = new Map<string, Set<string>>();
	const normalized: HostedContribution<Value>[] = [];
	for (const contribution of contributions) {
		const validated = readContribution(contribution);
		const contributionIds = contributionIdsByPlugin.get(validated.pluginId) ?? new Set<string>();
		if (contributionIds.has(validated.contributionId)) {
			throw new PluginHostError(
				'invalid_contribution',
				`Plugin ${validated.pluginId} has duplicate contribution ${validated.contributionId}`,
				{ pluginId: validated.pluginId }
			);
		}
		contributionIds.add(validated.contributionId);
		contributionIdsByPlugin.set(validated.pluginId, contributionIds);
		normalized.push(validated);
	}

	return Object.freeze(
		normalized.sort(
			(left, right) =>
				compareCodePoints(left.pluginId, right.pluginId) ||
				compareCodePoints(left.contributionId, right.contributionId)
		)
	);
}

function readContribution<Value>(
	contribution: HostedContribution<Value>
): HostedContribution<Value> {
	if (contribution === null || typeof contribution !== 'object') {
		return invalidContribution();
	}
	const keys = Reflect.ownKeys(contribution);
	const pluginId = Object.getOwnPropertyDescriptor(contribution, 'pluginId');
	const contributionId = Object.getOwnPropertyDescriptor(contribution, 'contributionId');
	const value = Object.getOwnPropertyDescriptor(contribution, 'value');
	if (
		keys.length !== 3 ||
		!pluginId ||
		!('value' in pluginId) ||
		!isPluginId(pluginId.value) ||
		!contributionId ||
		!('value' in contributionId) ||
		typeof contributionId.value !== 'string' ||
		contributionId.value.trim().length === 0 ||
		contributionId.value.trim() !== contributionId.value ||
		!value ||
		!('value' in value)
	) {
		return invalidContribution(
			pluginId && 'value' in pluginId && typeof pluginId.value === 'string'
				? pluginId.value
				: undefined
		);
	}
	return Object.freeze({
		pluginId: pluginId.value,
		contributionId: contributionId.value,
		value: value.value,
	});
}

function invalidContribution(pluginId?: string): never {
	const validPluginId = isPluginId(pluginId) ? pluginId : undefined;
	throw new PluginHostError(
		'invalid_contribution',
		`Plugin ${pluginId ?? '<unknown>'} has a contribution without a stable identity`,
		{ pluginId: validPluginId }
	);
}
