import { describe, expect, it } from 'vitest';
import {
	CONTROLLER_OWNED_STRATEGIES,
	isControllerOwnedStrategy,
	PROVIDER_ROUTE_STRATEGIES,
	PROVIDER_ROUTE_STRATEGY_LABELS,
	strategyLabelFor,
} from '../providerRouteOptions';
import { routeProvidersForWrite, type TransportOption } from '../providerRouting';

const OPTIONS: readonly TransportOption[] = [
	{ kind: 'mta', label: 'Owlat MTA', isAvailable: true, isRegistered: true },
	{ kind: 'ses', label: 'Amazon SES', isAvailable: true, isRegistered: true },
];

describe('provider route strategy labels', () => {
	it('labels every known strategy kind', () => {
		expect(strategyLabelFor('single')).toBe('Single provider');
		expect(strategyLabelFor('priority_failover')).toBe('Priority failover');
		expect(strategyLabelFor('workload_split')).toBe('Workload split');
		expect(strategyLabelFor('adaptive_mix')).toBe('Adaptive mix (managed)');
	});

	it('falls back to the raw kind for a strategy this build does not know', () => {
		expect(strategyLabelFor('future_kind')).toBe('future_kind');
		expect(strategyLabelFor('')).toBe('');
		// A prototype-chain key is a miss, not an inherited function.
		expect(strategyLabelFor('toString')).toBe('toString');
	});

	it('sources the picker labels from the label record so one edit moves both', () => {
		for (const entry of PROVIDER_ROUTE_STRATEGIES) {
			expect(entry.label).toBe(PROVIDER_ROUTE_STRATEGY_LABELS[entry.value]);
		}
	});
});

describe('controller-owned strategies', () => {
	it('classifies adaptive_mix as controller-owned and the operator kinds as not', () => {
		expect(isControllerOwnedStrategy('adaptive_mix')).toBe(true);
		expect(isControllerOwnedStrategy('single')).toBe(false);
		expect(isControllerOwnedStrategy('priority_failover')).toBe(false);
		expect(isControllerOwnedStrategy('workload_split')).toBe(false);
		expect(isControllerOwnedStrategy('future_kind')).toBe(false);
	});

	it('never offers a controller-owned kind in the picker', () => {
		expect(
			PROVIDER_ROUTE_STRATEGIES.every((entry) => !isControllerOwnedStrategy(entry.value))
		).toBe(true);
		for (const kind of CONTROLLER_OWNED_STRATEGIES) {
			expect(PROVIDER_ROUTE_STRATEGIES.some((entry) => entry.value === kind)).toBe(false);
		}
	});

	it('still has a label for every controller-owned kind so an existing route renders', () => {
		for (const kind of CONTROLLER_OWNED_STRATEGIES) {
			expect(strategyLabelFor(kind)).not.toBe(kind);
		}
	});
});

describe('routeProvidersForWrite under a controller-owned strategy', () => {
	it('drops per-provider weights for adaptive_mix, as for every non-split strategy', () => {
		const written = routeProvidersForWrite(
			OPTIONS,
			[
				{ providerType: 'mta', weight: 70, isEnabled: true },
				{ providerType: 'ses', weight: 30, isEnabled: true },
			],
			'adaptive_mix'
		);
		expect(written).toEqual([
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: true },
		]);
		expect(written.every((provider) => provider.weight === undefined)).toBe(true);
	});

	it('keeps weights for workload_split', () => {
		const written = routeProvidersForWrite(
			OPTIONS,
			[{ providerType: 'mta', weight: 70, isEnabled: true }],
			'workload_split'
		);
		expect(written[0]?.weight).toBe(70);
	});
});
