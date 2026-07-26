import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_OBSERVATION_SCHEMA_VERSION,
	serializeDeliverabilityObservation,
} from '../deliverabilityDiagnostics';

describe('structured deliverability observations', () => {
	it('preserves reserved kind and schema version while bounding escape-heavy values', () => {
		const kind = `dns.provider.${'\\'.repeat(100)}`;
		const serialized = serializeDeliverabilityObservation({
			kind,
			value: `${'"\\\n'.repeat(400)}tail`,
		});
		const observation = JSON.parse(serialized);

		expect(serialized.length).toBeLessThanOrEqual(512);
		expect(observation.kind).toBe(kind);
		expect(observation.schemaVersion).toBe(DELIVERABILITY_OBSERVATION_SCHEMA_VERSION);
		expect(observation.value.length).toBeLessThan(1_604);
	});

	it('overwrites a caller-supplied schema version', () => {
		expect(
			JSON.parse(
				serializeDeliverabilityObservation({
					kind: 'dns.provider',
					schemaVersion: 999,
					value: 'observed',
				})
			)
		).toEqual({
			kind: 'dns.provider',
			schemaVersion: DELIVERABILITY_OBSERVATION_SCHEMA_VERSION,
			value: 'observed',
		});
	});

	it('rejects observations without an honest kind', () => {
		expect(() => serializeDeliverabilityObservation({ value: 'observed' })).toThrow(
			'Deliverability observation kind is required'
		);
	});
});
