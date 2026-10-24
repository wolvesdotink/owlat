/**
 * The shape of the frozen worker wire fixtures (see `./index.ts`).
 */

import type { AnyWorkerEndpoint, EndpointResult, EndpointReturns } from '../contract';

/** One recorded answer, named for the outcome it shows. */
export interface WireFixtureCase<T> {
	readonly name: string;
	readonly value: T;
}

/** At least one case per endpoint: the type is what makes the set exhaustive. */
export type WireFixtureCases<T> = readonly [WireFixtureCase<T>, ...WireFixtureCase<T>[]];

/** What the current backend answers with, per endpoint of a registry. */
export type WireFixtures<R extends Record<string, AnyWorkerEndpoint>> = {
	readonly [K in keyof R]: WireFixtureCases<EndpointReturns<R[K]>>;
};

/**
 * Answers only an OLDER backend gives, which a worker still accepts mid-rollout.
 * They match `accepts` and must NOT match `returns`.
 */
export type LegacyWireFixtures<R extends Record<string, AnyWorkerEndpoint>> = {
	readonly [K in keyof R]?: WireFixtureCases<EndpointResult<R[K]>>;
};

/**
 * Placeholders stand where a value is minted by the deployment rather than
 * chosen by the fixture: document ids, storage URLs, pagination cursors and
 * membership versions. A backend test binds each one to the value its own
 * seeded deployment produced; a worker test passes them through as the opaque
 * strings they are.
 */
export const WIRE_PLACEHOLDER_PREFIX = '@wire/';

export function wirePlaceholder(name: string): string {
	return `${WIRE_PLACEHOLDER_PREFIX}${name}`;
}

/**
 * The fixture with every placeholder replaced by `bindings[placeholder]`.
 * Throws on a placeholder left unbound, so a backend test cannot pass by
 * comparing a placeholder with itself.
 */
export function bindWirePlaceholders<T>(value: T, bindings: Readonly<Record<string, string>>): T {
	const walk = (node: unknown): unknown => {
		if (typeof node === 'string') {
			if (!node.startsWith(WIRE_PLACEHOLDER_PREFIX)) return node;
			const bound = bindings[node];
			if (bound === undefined) throw new Error(`wire fixture placeholder ${node} is not bound`);
			return bound;
		}
		if (Array.isArray(node)) return node.map(walk);
		if (node !== null && typeof node === 'object') {
			return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, walk(inner)]));
		}
		return node;
	};
	return walk(value) as T;
}
