import { PluginHostError } from './errors';

export interface HostedContribution<Value> {
	readonly pluginId: string;
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
	const identities = new Set<string>();
	const normalized: HostedContribution<Value>[] = [];
	for (const contribution of contributions) {
		const validated = readContribution(contribution);
		const identity = `${validated.pluginId}\0${validated.contributionId}`;
		if (identities.has(identity)) {
			throw new PluginHostError(
				'invalid_contribution',
				`Plugin ${validated.pluginId} has duplicate contribution ${validated.contributionId}`,
				{ pluginId: validated.pluginId }
			);
		}
		identities.add(identity);
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
		typeof pluginId.value !== 'string' ||
		pluginId.value.trim().length === 0 ||
		!contributionId ||
		!('value' in contributionId) ||
		typeof contributionId.value !== 'string' ||
		contributionId.value.trim().length === 0 ||
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

function invalidContribution(pluginId = '<unknown>'): never {
	throw new PluginHostError(
		'invalid_contribution',
		`Plugin ${pluginId} has a contribution without a stable identity`,
		{ pluginId }
	);
}

function compareCodePoints(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
