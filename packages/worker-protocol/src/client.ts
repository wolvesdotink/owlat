/**
 * The worker side of the contract: function references built from the
 * endpoint registries, and a Convex client that checks every answer.
 *
 * A worker reads Convex over HTTP, so nothing about an answer is checked on the
 * way in unless the worker checks it. The checked client looks each reference
 * up in the worker's registry BEFORE sending it (an unknown function or a wrong
 * kind is refused without running anything), then matches the answer against
 * the endpoint's `accepts` validator. Unknown object keys are let through:
 * a backend one release ahead may answer with a field this build has never
 * heard of, and an additive change must not stop a worker mid-rollout. Every
 * declared field is checked.
 */

import {
	getFunctionName,
	makeFunctionReference,
	type FunctionArgs,
	type FunctionReference,
	type FunctionReturnType,
} from 'convex/server';
import type { AnyWorkerEndpoint, EndpointArgs, EndpointKind, EndpointResult } from './contract';
import { validatorMismatch } from './validatorMatch';

/** A typed reference to one endpoint, as `ConvexHttpClient` calls it. */
export type WorkerReference<E extends AnyWorkerEndpoint> = FunctionReference<
	E['kind'],
	'public',
	EndpointArgs<E>,
	EndpointResult<E>
>;

export type WorkerReferences<R extends Record<string, AnyWorkerEndpoint>> = {
	readonly [K in keyof R]: WorkerReference<R[K]>;
};

/** The function references for a registry, under the registry's own names. */
export function workerReferences<R extends Record<string, AnyWorkerEndpoint>>(
	registry: R
): WorkerReferences<R> {
	const refs: Record<string, FunctionReference<EndpointKind, 'public'>> = {};
	for (const [name, endpoint] of Object.entries(registry)) {
		refs[name] = makeFunctionReference<EndpointKind>(endpoint.path);
	}
	return refs as unknown as WorkerReferences<R>;
}

/**
 * An answer, or a call, that does not fit the contract.
 *
 * `hasRun` says whether the backend executed the call. When it did, a mutation
 * or action has already committed its effects, so the caller must not repeat
 * the call to "get a better answer": the error is reported, and whatever
 * re-runs the work later starts again from the backend's state.
 */
export class WireContractError extends Error {
	constructor(
		readonly path: string,
		readonly kind: EndpointKind,
		readonly mismatch: string,
		readonly hasRun: boolean
	) {
		super(
			hasRun
				? `${kind} ${path} answered outside its wire contract (${mismatch}); the call has run and is not retried`
				: `${kind} ${path} refused before sending: ${mismatch}`
		);
		this.name = 'WireContractError';
	}
}

export function isWireContractError(err: unknown): err is WireContractError {
	return err instanceof WireContractError;
}

/** The slice of `ConvexHttpClient` the checked client drives. */
export interface ConvexTransport {
	query(ref: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>;
	mutation(ref: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>;
	action(ref: FunctionReference<'action'>, args: Record<string, unknown>): Promise<unknown>;
}

/** The surface worker code calls: `ConvexHttpClient`'s, with every answer checked. */
export interface CheckedConvexClient {
	query<Ref extends FunctionReference<'query'>>(
		ref: Ref,
		args: FunctionArgs<Ref>
	): Promise<FunctionReturnType<Ref>>;
	mutation<Ref extends FunctionReference<'mutation'>>(
		ref: Ref,
		args: FunctionArgs<Ref>
	): Promise<FunctionReturnType<Ref>>;
	action<Ref extends FunctionReference<'action'>>(
		ref: Ref,
		args: FunctionArgs<Ref>
	): Promise<FunctionReturnType<Ref>>;
}

/** The registry keyed by path, refusing two names for one function. */
function byPath(registry: Record<string, AnyWorkerEndpoint>): Map<string, AnyWorkerEndpoint> {
	const endpoints = new Map<string, AnyWorkerEndpoint>();
	for (const [name, endpoint] of Object.entries(registry)) {
		if (endpoints.has(endpoint.path)) {
			throw new Error(`worker registry names ${endpoint.path} twice (again as ${name})`);
		}
		endpoints.set(endpoint.path, endpoint);
	}
	return endpoints;
}

export function createCheckedClient(
	transport: ConvexTransport,
	registry: Record<string, AnyWorkerEndpoint>
): CheckedConvexClient {
	const endpoints = byPath(registry);

	async function call(
		kind: EndpointKind,
		ref: FunctionReference<EndpointKind>,
		args: Record<string, unknown>
	): Promise<unknown> {
		const path = getFunctionName(ref);
		const endpoint = endpoints.get(path);
		if (endpoint === undefined) {
			throw new WireContractError(path, kind, 'not in this worker’s contract', false);
		}
		if (endpoint.kind !== kind) {
			throw new WireContractError(path, kind, `declared as a ${endpoint.kind}`, false);
		}
		const result =
			kind === 'query'
				? await transport.query(ref as FunctionReference<'query'>, args)
				: kind === 'mutation'
					? await transport.mutation(ref as FunctionReference<'mutation'>, args)
					: await transport.action(ref as FunctionReference<'action'>, args);
		const mismatch = validatorMismatch(endpoint.accepts, result, { unknownKeys: 'ignore' });
		if (mismatch !== null) throw new WireContractError(path, kind, mismatch, true);
		return result;
	}

	return {
		query: async (ref, args) => (await call('query', ref, args)) as FunctionReturnType<typeof ref>,
		mutation: async (ref, args) =>
			(await call('mutation', ref, args)) as FunctionReturnType<typeof ref>,
		action: async (ref, args) =>
			(await call('action', ref, args)) as FunctionReturnType<typeof ref>,
	};
}
