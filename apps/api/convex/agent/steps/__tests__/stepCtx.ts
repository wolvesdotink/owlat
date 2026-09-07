import { getFunctionName } from 'convex/server';

/**
 * A route answers one generated function. A plain value is returned as-is; a
 * function is called with the handler's args so a route can record or branch.
 * (`object` rather than `unknown` for the value half, so an arrow literal is
 * contextually typed by the function half instead of falling to implicit any.)
 */
type RouteFn = (args: unknown) => unknown;
type RouteValue = string | number | boolean | null | undefined | object;
type Route = RouteFn | RouteValue;

export interface StepCtxRoutes {
	/** Keyed by a fragment of the generated function name (`getMessage`, `knowledge`). */
	readonly queries?: Readonly<Record<string, Route>>;
	readonly actions?: Readonly<Record<string, Route>>;
	readonly mutations?: Readonly<Record<string, Route>>;
}

const named = (ref: unknown): string =>
	getFunctionName(ref as Parameters<typeof getFunctionName>[0]);

function dispatcher(
	kind: 'runQuery' | 'runAction' | 'runMutation',
	routes: Readonly<Record<string, Route>>
) {
	return async (ref: unknown, args?: unknown): Promise<unknown> => {
		const name = named(ref);
		const key = Object.keys(routes).find((fragment) => name.includes(fragment));
		if (key === undefined) throw new Error(`unexpected ${kind}: ${name}`);
		const route = routes[key];
		return typeof route === 'function' ? (route as RouteFn)(args) : route;
	};
}

/**
 * The step-execution context every agent step suite fakes: `runQuery`,
 * `runAction` and `runMutation` routed by a fragment of the generated function
 * name, and a loud failure for a name no route answers, so a step that starts
 * reaching for something new fails here rather than returning undefined.
 */
export function makeStepCtx<Ctx>(routes: StepCtxRoutes): Ctx {
	return {
		runQuery: dispatcher('runQuery', routes.queries ?? {}),
		runAction: dispatcher('runAction', routes.actions ?? {}),
		runMutation: dispatcher('runMutation', routes.mutations ?? {}),
	} as unknown as Ctx;
}
