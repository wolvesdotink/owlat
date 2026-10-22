/**
 * The public types of the session-threaded builders in `./authedFunctions`:
 * `typeof query` / `typeof mutation` with the floor's resolved session (or
 * another resolved `Floor`) appended to the handler's parameters. Kept apart
 * from the builders so the builder module holds runtime behaviour only.
 */

import type { GenericValidator, ObjectType, PropertyValidators } from 'convex/values';
import type {
	RegisteredMutation,
	RegisteredQuery,
	ReturnValueForOptionalValidator,
} from 'convex/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { MutationSessionContext } from './sessionOrganization';

/**
 * The config object a session-threaded builder accepts — `args` / `returns` /
 * `handler` exactly as the raw builders take them, with the floor's resolved
 * session appended to the handler's parameter list.
 *
 * `args` is a required `PropertyValidators` record (`args: {}` for the zero-arg
 * case), which is both the shape every function in this backend declares and the
 * shape `bun run lint:patterns` enforces.
 */
interface SessionFunctionConfig<
	Ctx,
	ArgsValidator extends PropertyValidators,
	ReturnsValidator,
	ReturnValue,
	Floor,
> {
	args: ArgsValidator;
	returns?: ReturnsValidator;
	handler: (ctx: Ctx, args: ObjectType<ArgsValidator>, session: Floor) => ReturnValue;
}

/** `typeof query`, with the floor's session (or other resolved `Floor`) threaded to the handler. */
export interface SessionQueryBuilder<Floor = MutationSessionContext> {
	<
		ArgsValidator extends PropertyValidators,
		ReturnsValidator extends PropertyValidators | GenericValidator | void = void,
		ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> =
			ReturnValueForOptionalValidator<ReturnsValidator>,
	>(
		fn: SessionFunctionConfig<QueryCtx, ArgsValidator, ReturnsValidator, ReturnValue, Floor>
	): RegisteredQuery<'public', ObjectType<ArgsValidator>, ReturnValue>;
}

/** `typeof mutation`, with the floor's session (or other resolved `Floor`) threaded to the handler. */
export interface SessionMutationBuilder<Floor = MutationSessionContext> {
	<
		ArgsValidator extends PropertyValidators,
		ReturnsValidator extends PropertyValidators | GenericValidator | void = void,
		ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> =
			ReturnValueForOptionalValidator<ReturnsValidator>,
	>(
		fn: SessionFunctionConfig<MutationCtx, ArgsValidator, ReturnsValidator, ReturnValue, Floor>
	): RegisteredMutation<'public', ObjectType<ArgsValidator>, ReturnValue>;
}
