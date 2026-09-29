/**
 * THE SCHEMA AND ITS VALIDATORS DO NOT LOAD RUNTIME CODE.
 *
 * `convex/schema.ts` and `convex/schema/*.ts` describe tables. Whatever they
 * import at runtime is loaded with them, so a validator that lives next to a
 * mutation drags that module, and `_generated/api` or the BetterAuth session
 * read behind it, into the schema's graph. That is an import cycle waiting to
 * happen. Two rules, walked over VALUE imports only (`import type` and
 * `export type` are erased and never followed):
 *
 *   1. The transitive closure of the schema never reaches `_generated/api`,
 *      `_generated/server` or `lib/sessionOrganization`. Leaf catalogs such as
 *      `auditActions/catalog` stay importable; a validator found behind a
 *      runtime module moves into `lib/validators/`.
 *   2. `lib/validators/*.ts` is a leaf: its closure stays inside
 *      `lib/validators/`, `convex/values`, `@owlat/*` and the few leaf
 *      modules listed in `VALIDATOR_LEAF_DEPENDENCIES`.
 *
 * The rules live in `convex/CONVENTIONS.md` ("Validators").
 *
 * Run by `bun run lint` (apps/api): `bun scripts/check-schema-imports.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	createChecker,
	productionModules,
	resolveRelative,
	stripComments,
	valueImportSpecifiers,
} from './lib/sourceGraph';

const convexRoot = join(import.meta.dirname, '..', 'convex');

/** Modules the schema's closure must never load (paths without extension). */
const RUNTIME_MODULES = ['_generated/api', '_generated/server', 'lib/sessionOrganization'];

/**
 * Modules outside `lib/validators/` a validator may load. Each is a leaf
 * itself (rule 2 walks through it): the literal-union helper, the shared
 * literal unions (a send's `bounceType`) and the two adapter-registry kind
 * tuples the AI-provider validators derive from.
 */
const VALIDATOR_LEAF_DEPENDENCIES = [
	'lib/literalUnion.ts',
	'lib/literalValidators.ts',
	'lib/llmProviders/types.ts',
	'lib/decisionProviders/types.ts',
];

const VALIDATORS_DIR = 'lib/validators/';

const { check, expectEmpty, report } = createChecker();

const toPosix = (path: string): string => path.split('\\').join('/');
const rel = (path: string): string => toPosix(relative(convexRoot, path));
const withoutExtension = (path: string): string => path.replace(/(?:\/index)?\.ts$/, '');

interface Edge {
	/** Bare package specifiers the module loads. */
	packages: string[];
	/** Relative targets, as convex-relative paths (`.ts` files, or a `_generated` stem). */
	modules: string[];
}

const edges = new Map<string, Edge>();

/** The runtime edges out of `file` (a convex-relative path). */
function edgesOf(file: string): Edge {
	const cached = edges.get(file);
	if (cached !== undefined) return cached;
	const source = stripComments(readFileSync(join(convexRoot, file), 'utf8'));
	const edge: Edge = { packages: [], modules: [] };
	for (const specifier of valueImportSpecifiers(source)) {
		if (!specifier.startsWith('.')) {
			edge.packages.push(specifier);
			continue;
		}
		const candidates = resolveRelative(file, specifier);
		const stem = withoutExtension(candidates[0] ?? '');
		if (stem.startsWith('_generated/')) {
			edge.modules.push(stem);
			continue;
		}
		const found = candidates.find((candidate) => existsSync(join(convexRoot, candidate)));
		check(found !== undefined, `${file}: cannot resolve '${specifier}'`);
		if (found !== undefined) edge.modules.push(found);
	}
	edges.set(file, edge);
	return edge;
}

/**
 * Breadth-first walk of the value-import closure from `roots`. Returns each
 * reached module with the chain that first reached it.
 */
function closure(roots: readonly string[]): Map<string, string[]> {
	const chains = new Map<string, string[]>(roots.map((root) => [root, [root]]));
	const queue = [...roots];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		const chain = chains.get(file) ?? [file];
		// A `_generated` stem has no source here; it is a target, never walked.
		if (file.startsWith('_generated/')) continue;
		for (const target of edgesOf(file).modules) {
			if (chains.has(target)) continue;
			chains.set(target, [...chain, target]);
			queue.push(target);
		}
	}
	return chains;
}

const schemaRoots = [
	...(existsSync(join(convexRoot, 'schema.ts')) ? ['schema.ts'] : []),
	...productionModules(join(convexRoot, 'schema')).map(rel),
];

check(schemaRoots.includes('schema.ts'), 'convex/schema.ts not found: nothing to walk');

// Rule 1: the schema never reaches a runtime module.
const schemaClosure = closure(schemaRoots);
expectEmpty(
	[...schemaClosure]
		.filter(([module]) => RUNTIME_MODULES.includes(withoutExtension(module)))
		.map(([, chain]) => chain.join(' -> ')),
	'the schema loads runtime code at import time. Move the validator it needs into ' +
		'lib/validators/ (see convex/CONVENTIONS.md, "Validators"):'
);

// Rule 2: lib/validators/ is a leaf.
const validatorRoots = productionModules(join(convexRoot, VALIDATORS_DIR)).map(rel);
const validatorClosure = closure(validatorRoots);
const outsideLeaf = [...validatorClosure].filter(
	([module]) => !module.startsWith(VALIDATORS_DIR) && !VALIDATOR_LEAF_DEPENDENCIES.includes(module)
);
const foreignPackages = [...validatorClosure.keys()].flatMap((module) =>
	module.startsWith('_generated/')
		? []
		: edgesOf(module)
				.packages.filter((name) => name !== 'convex/values' && !name.startsWith('@owlat/'))
				.map((name) => `${module} -> ${name}`)
);
expectEmpty(
	[...outsideLeaf.map(([, chain]) => chain.join(' -> ')), ...foreignPackages],
	`${VALIDATORS_DIR} loads a module outside its leaf set (convex/values, @owlat/*, ` +
		`${VALIDATORS_DIR}, ${VALIDATOR_LEAF_DEPENDENCIES.join(', ')}):`
);

report(
	'check-schema-imports',
	`${schemaClosure.size} modules behind the schema, ${validatorRoots.length} validator modules`
);
