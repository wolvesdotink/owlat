import { parsePluginId, type PluginId } from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import { orderHostedContributions, PluginHostError } from '../index';

const pluginId = (value: string): PluginId => parsePluginId(value);

describe('hosted contribution ordering', () => {
	it('orders by plugin then contribution identity without mutating input', () => {
		const alphaFirstValue = { marker: 3 };
		const input = [
			{ pluginId: pluginId('zeta'), contributionId: 'first', value: { marker: 1 } },
			{ pluginId: pluginId('alpha'), contributionId: 'second', value: { marker: 2 } },
			{ pluginId: pluginId('alpha'), contributionId: 'first', value: alphaFirstValue },
		];

		const ordered = orderHostedContributions(input);

		expect(ordered.map(({ pluginId, contributionId }) => `${pluginId}/${contributionId}`)).toEqual([
			'alpha/first',
			'alpha/second',
			'zeta/first',
		]);
		expect(input.map(({ pluginId }) => pluginId)).toEqual(['zeta', 'alpha', 'alpha']);
		expect(ordered[0]?.value).toBe(alphaFirstValue);
		expect(Object.isFrozen(ordered)).toBe(true);
		expect(Object.isFrozen(ordered[0])).toBe(true);
	});

	it('uses code-point ordering rather than locale-dependent comparison', () => {
		const ordered = orderHostedContributions([
			{ pluginId: pluginId('alpha'), contributionId: 'z', value: 1 },
			{ pluginId: pluginId('alpha'), contributionId: 'Z', value: 2 },
		]);

		expect(ordered.map(({ contributionId }) => contributionId)).toEqual(['Z', 'z']);
	});

	it('rejects a duplicate identity even when the values differ', () => {
		expect(() =>
			orderHostedContributions([
				{ pluginId: pluginId('alpha'), contributionId: 'same', value: 1 },
				{ pluginId: pluginId('alpha'), contributionId: 'same', value: 2 },
			])
		).toThrowError(
			expect.objectContaining<Partial<PluginHostError>>({ code: 'invalid_contribution' })
		);
	});

	it('allows the same local identity in different plugin namespaces', () => {
		expect(
			orderHostedContributions([
				{ pluginId: pluginId('alpha'), contributionId: 'shared', value: 1 },
				{ pluginId: pluginId('beta'), contributionId: 'shared', value: 2 },
			])
		).toHaveLength(2);
	});

	it('rejects identity accessors without executing them', () => {
		let reads = 0;
		const contribution = { contributionId: 'item', value: 1 };
		Object.defineProperty(contribution, 'pluginId', {
			enumerable: true,
			get() {
				reads += 1;
				return 'alpha';
			},
		});

		expect(() =>
			orderHostedContributions([
				contribution as unknown as {
					pluginId: PluginId;
					contributionId: string;
					value: number;
				},
			])
		).toThrowError(expect.objectContaining({ code: 'invalid_contribution' }));
		expect(reads).toBe(0);
	});

	it('rejects leading or trailing whitespace instead of silently normalizing identities', () => {
		expect(() =>
			orderHostedContributions([
				{ pluginId: 'alpha ' as PluginId, contributionId: 'item', value: 1 },
			])
		).toThrowError(expect.objectContaining({ code: 'invalid_contribution' }));

		expect(() =>
			orderHostedContributions([{ pluginId: pluginId('alpha'), contributionId: ' item', value: 1 }])
		).toThrowError(expect.objectContaining({ code: 'invalid_contribution' }));
	});
});
