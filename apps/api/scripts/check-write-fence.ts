/**
 * EVERY MUTATION IS BUILT BEHIND THE WORKSPACE WRITE FENCE.
 *
 * While a workspace deletion runs, `lib/writeFence.ts` refuses writes to the
 * tables it sweeps. The fence sits in the builders: the public ones in
 * `lib/authedFunctions.ts` build on a fenced `mutation`, and every internal
 * mutation uses the fenced `internalMutation` exported by `lib/writeFence.ts`.
 * A module that imports a raw mutation builder writes around the fence, so a
 * row it creates mid-deletion survives the sweep (#898).
 *
 * This walk fails on any value import of a raw mutation builder outside the
 * modules allowed to hold one:
 *
 *   - `_generated/server`'s `internalMutation`: `lib/writeFence.ts` (it wraps
 *     it) and `workspaces/deletion/walker.ts` (the deletion worker, the one
 *     writer the fence exempts);
 *   - `_generated/server`'s `mutation`: `lib/authedFunctions.ts` (it wraps it);
 *   - `convex/server`'s `mutationGeneric` / `internalMutationGeneric`: nowhere.
 *
 * Run by `bun run lint` (apps/api): `bun scripts/check-write-fence.ts`.
 */
import { join } from 'node:path';
import {
	boundNames,
	createChecker,
	IMPORT_DECLARATION,
	productionModules,
	resolveRelative,
	sourceMap,
} from './lib/sourceGraph';

const convexRoot = join(import.meta.dirname, '..', 'convex');
const { check, expectEmpty, report } = createChecker();

const RAW_SERVER_BUILDERS: Readonly<Record<string, readonly string[]>> = {
	internalMutation: ['lib/writeFence.ts', 'workspaces/deletion/walker.ts'],
	mutation: ['lib/authedFunctions.ts'],
};
const GENERIC_BUILDERS = ['mutationGeneric', 'internalMutationGeneric'];

/** The imported (left-hand) name of every specifier in an import clause. */
function importedNames(clause: string): string[] {
	return clause
		.replace(/[{}]/g, ' ')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && !/^type\s/.test(entry))
		.map((entry) => entry.split(/\s+as\s+/)[0]?.trim() ?? '');
}

const sources = sourceMap(convexRoot, productionModules(convexRoot));
check(sources.size > 500, `walked only ${sources.size} backend modules`);

const violations: string[] = [];
const holders = new Map<string, Set<string>>();
for (const [module, source] of sources) {
	for (const match of source.matchAll(IMPORT_DECLARATION)) {
		const clause = match[1] ?? '';
		const specifier = match[2] ?? '';
		if (boundNames(clause).length === 0) continue;
		const names = importedNames(clause);
		const isServer = resolveRelative(module, specifier).includes('_generated/server.ts');
		if (isServer) {
			for (const name of names) {
				const allowed = RAW_SERVER_BUILDERS[name];
				if (allowed === undefined) continue;
				if (!allowed.includes(module)) {
					violations.push(`${module}: raw \`${name}\` from _generated/server`);
				} else {
					holders.set(name, (holders.get(name) ?? new Set()).add(module));
				}
			}
		}
		if (specifier === 'convex/server') {
			for (const name of names.filter((n) => GENERIC_BUILDERS.includes(n))) {
				violations.push(`${module}: \`${name}\` from convex/server`);
			}
		}
	}
}

expectEmpty(
	violations,
	'a mutation builder that bypasses the workspace write fence (import `internalMutation` from lib/writeFence.ts, or use a builder from lib/authedFunctions.ts):'
);
// The allowances are exact: a holder that stopped importing its raw builder
// leaves a stale exemption behind.
for (const [name, allowed] of Object.entries(RAW_SERVER_BUILDERS)) {
	for (const module of allowed) {
		check(
			holders.get(name)?.has(module) === true,
			`${module} is allowed a raw \`${name}\` but no longer imports one: drop the allowance`
		);
	}
}
check(
	/fenceMutationBuilder\(rawMutation\)/.test(sources.get('lib/authedFunctions.ts') ?? ''),
	'lib/authedFunctions.ts no longer builds its public mutations on fenceMutationBuilder(rawMutation)'
);

report('check-write-fence', `${sources.size} modules`);
