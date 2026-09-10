/**
 * Dispatch-pipeline contexts at each enrichment stage, for the phase suites.
 */
import type { BasePhaseCtx, CtxWithIp, CtxWithPool } from '../../dispatch/types.js';
import type { DestinationSnapshot } from '../../smtp/destinationProvider.js';
import { createOwlatJob } from './fixtures.js';

export function makeDestination(overrides?: Partial<DestinationSnapshot>): DestinationSnapshot {
	return {
		recipientDomain: 'example.com',
		providerKey: 'other',
		throttleKey: 'example.com',
		mx: {
			status: 'deliverable',
			source: 'mx',
			hosts: [{ exchange: 'mx.example.com', priority: 0 }],
		},
		daneDiscoveryAuthenticated: true,
		...overrides,
	};
}

export function makeDispatchCtx(overrides?: Partial<BasePhaseCtx>): BasePhaseCtx {
	return {
		job: createOwlatJob(),
		domain: 'example.com',
		destination: makeDestination(),
		fromDomain: 'owlat.com',
		...overrides,
	};
}

/** The ctx after `resolvePool`. */
export function makeCtxWithPool(overrides?: Partial<CtxWithPool>): CtxWithPool {
	return { ...makeDispatchCtx(), pool: 'transactional', dedicatedIp: undefined, ...overrides };
}

/** The ctx after `selectIp`. */
export function makeCtxWithIp(overrides?: Partial<CtxWithIp>): CtxWithIp {
	return { ...makeCtxWithPool(), ip: '10.0.0.1', eligibilityGeneration: 1, ...overrides };
}
