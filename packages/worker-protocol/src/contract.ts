/**
 * One worker-called Convex function, declared once.
 *
 * An endpoint names the function (`path`, `kind`) and carries the two Convex
 * validators both sides use: apps/api registers `args` and `returns` on the
 * function itself, so Convex refuses a call or an answer that does not fit, and
 * the worker derives its argument and result types from the same objects and
 * checks every answer against them at runtime (`client.ts`).
 *
 * `accepts` is what the WORKER takes, which may be wider than what the current
 * backend `returns`: a result shape an older backend still answers with during
 * a rolling deploy. It defaults to `returns`.
 */

import type {
	GenericId,
	GenericValidator,
	Infer,
	ObjectType,
	PropertyValidators,
} from 'convex/values';

export type EndpointKind = 'query' | 'mutation' | 'action';

export interface WorkerEndpoint<
	Kind extends EndpointKind = EndpointKind,
	Args extends PropertyValidators = PropertyValidators,
	Returns extends GenericValidator = GenericValidator,
	Accepts extends GenericValidator = Returns,
> {
	/** `module/path:exportName`, the string `ConvexHttpClient` addresses it by. */
	readonly path: string;
	readonly kind: Kind;
	readonly args: Args;
	readonly returns: Returns;
	readonly accepts: Accepts;
}

/** Any endpoint, whatever its validators. */
export type AnyWorkerEndpoint = WorkerEndpoint<
	EndpointKind,
	PropertyValidators,
	GenericValidator,
	GenericValidator
>;

export function defineEndpoint<
	const Kind extends EndpointKind,
	Args extends PropertyValidators,
	Returns extends GenericValidator,
>(definition: {
	path: string;
	kind: Kind;
	args: Args;
	returns: Returns;
}): WorkerEndpoint<Kind, Args, Returns, Returns>;
export function defineEndpoint<
	const Kind extends EndpointKind,
	Args extends PropertyValidators,
	Returns extends GenericValidator,
	Accepts extends GenericValidator,
>(definition: {
	path: string;
	kind: Kind;
	args: Args;
	returns: Returns;
	accepts: Accepts;
}): WorkerEndpoint<Kind, Args, Returns, Accepts>;
export function defineEndpoint(definition: {
	path: string;
	kind: EndpointKind;
	args: PropertyValidators;
	returns: GenericValidator;
	accepts?: GenericValidator;
}): AnyWorkerEndpoint {
	return Object.freeze({ ...definition, accepts: definition.accepts ?? definition.returns });
}

/**
 * A value as it crosses the wire to a worker: a document id is the plain string
 * it serializes to. The workers never import apps/api's data model, so they
 * carry ids as strings and hand them back unchanged.
 */
export type Wire<T> =
	T extends GenericId<string>
		? string
		: T extends ReadonlyArray<infer Element>
			? Wire<Element>[]
			: T extends object
				? { [K in keyof T]: Wire<T[K]> }
				: T;

/** The arguments a worker passes: an object, whatever its fields. */
export type EndpointArgs<E extends AnyWorkerEndpoint> = {
	[K in keyof ObjectType<E['args']>]: Wire<ObjectType<E['args']>[K]>;
};

/** The result a worker reads: what it {@link WorkerEndpoint.accepts}. */
export type EndpointResult<E extends AnyWorkerEndpoint> = Wire<Infer<E['accepts']>>;

/** The result the current backend produces: its `returns`. */
export type EndpointReturns<E extends AnyWorkerEndpoint> = Wire<Infer<E['returns']>>;
