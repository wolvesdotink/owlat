/**
 * Every function a worker calls is registered with the worker wire contract's
 * own validators.
 *
 * The IMAP server and the mail-sync worker build their function references and
 * their result checks from `@owlat/worker-protocol`; this pins the other end:
 * the function at each contract `path` is internal, of the contract's kind, and
 * registered with exactly the contract's `args` and `returns`. A handler that
 * declares its own validators beside the shared ones, or drops `returns`, fails
 * here before any worker meets the drift.
 */

import { IMAP_ENDPOINTS } from '@owlat/worker-protocol/imap';
import { MAIL_SYNC_ENDPOINTS } from '@owlat/worker-protocol/mailSync';
import type { AnyWorkerEndpoint } from '@owlat/worker-protocol';
import { v } from 'convex/values';
import { describe, expect, it } from 'vitest';

const sources = {
	...import.meta.glob('../mail/**/*.ts'),
	...import.meta.glob('../analytics/*.ts'),
};

/** A validator's JSON form, what `exportArgs` / `exportReturns` serialize. */
const jsonOf = (validator: unknown): unknown => (validator as { json: unknown }).json;

interface RegisteredFunction {
	isQuery?: boolean;
	isMutation?: boolean;
	isAction?: boolean;
	isInternal?: boolean;
	exportArgs(): string;
	exportReturns(): string;
}

async function registered(path: string): Promise<RegisteredFunction> {
	const [module, name] = path.split(':');
	const load = sources[`../${module}.ts`];
	if (!load) throw new Error(`no Convex module for ${path}`);
	const exported = ((await load()) as Record<string, unknown>)[name!];
	if (!exported) throw new Error(`${module}.ts does not export ${name}`);
	return exported as RegisteredFunction;
}

const REGISTRIES: ReadonlyArray<[string, Record<string, AnyWorkerEndpoint>]> = [
	['IMAP', IMAP_ENDPOINTS],
	['mail-sync', MAIL_SYNC_ENDPOINTS],
];

describe('worker-called functions use the wire contract', () => {
	it('no function is claimed by two contracts', () => {
		const paths = REGISTRIES.flatMap(([, registry]) =>
			Object.values(registry).map((endpoint) => endpoint.path)
		);
		expect(new Set(paths).size).toBe(paths.length);
	});

	for (const [worker, registry] of REGISTRIES) {
		for (const [key, endpoint] of Object.entries(registry)) {
			it(`${worker} ${key} (${endpoint.path})`, async () => {
				const fn = await registered(endpoint.path);
				expect(fn.isInternal, 'workers call internal functions with the admin key').toBe(true);
				const kind = fn.isQuery
					? 'query'
					: fn.isMutation
						? 'mutation'
						: fn.isAction
							? 'action'
							: null;
				expect(kind).toBe(endpoint.kind);
				expect(JSON.parse(fn.exportArgs())).toEqual(jsonOf(v.object(endpoint.args)));
				expect(JSON.parse(fn.exportReturns())).toEqual(jsonOf(endpoint.returns));
			});
		}
	}
});
