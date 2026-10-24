import { inScope, matchesAny, SCOPE_SCHEMA, slashed } from '../lib/paths.ts';
import type { ScopeOptions } from '../lib/paths.ts';
import { resolvedName, staticString } from '../lib/ast.ts';
import { builderTableFor, registeredFunctions } from '../lib/convexBuilders.ts';
import type { AstNode, Rule } from '../types.ts';

/**
 * Feature-flag floors belong in the builder, not in each handler. A gated
 * family exports builders composed with `featureGated` (e.g.
 * `externalMailMutation`), so a handler that repeats
 * `await assertFeatureEnabled(ctx, '<flag>')` by hand is a floor someone has to
 * remember, and the next handler in the file forgets it. The rule reports
 *
 *  (a) an `assertFeatureEnabled(…, '<flag>')` call inside a file of that flag's
 *      gated family (the `families` option: a flag and the files it gates),
 *      named after the top-level declaration holding it, and
 *  (b) a function registered with one of the `bareBuilders` (the plain
 *      org-member builders) in the files that option lists, which skipped the
 *      family's gated builder.
 *
 * `allow` lists the justified sites as `<path>:<name>`, grouped by reason:
 * soft-auth publicQuery reads that must keep an inline assert (marked
 * `// flag-inline:`), and modules that serve another surface. They are not
 * debt: each must stay as it is. An entry whose file is linted but no longer
 * reports that name is itself reported, so the list cannot outlive the code.
 */

interface Options extends ScopeOptions {
	families?: { flag: string; files: string[] }[];
	bareBuilders?: { builders: string[]; files: string[] };
	allow?: { sites: string[]; reason: string }[];
}

const MODULE = '<module>';

/** The name of the top-level declaration holding `node`, or `<module>`. */
const topLevelName = (node: AstNode): string => {
	let current: AstNode | null | undefined = node;
	while (current?.parent && current.parent.type !== 'Program') current = current.parent;
	let statement = current;
	if (
		(statement?.type === 'ExportNamedDeclaration' ||
			statement?.type === 'ExportDefaultDeclaration') &&
		statement.declaration
	) {
		statement = statement.declaration as AstNode;
	}
	if (statement?.type === 'FunctionDeclaration' && statement.id) return statement.id.name;
	if (statement?.type === 'VariableDeclaration') {
		const declarator = statement.declarations.find(
			(candidate) => candidate.start <= node.start && candidate.end >= node.end
		);
		if (declarator?.id.type === 'Identifier') return declarator.id.name;
	}
	return MODULE;
};

const rule: Rule = {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				"Use the family's featureGated builder instead of asserting its flag inside each handler.",
		},
		schema: [
			{
				type: 'object',
				properties: {
					...SCOPE_SCHEMA,
					families: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								flag: { type: 'string' },
								files: { type: 'array', items: { type: 'string' } },
							},
							required: ['flag', 'files'],
							additionalProperties: false,
						},
					},
					bareBuilders: {
						type: 'object',
						properties: {
							builders: { type: 'array', items: { type: 'string' } },
							files: { type: 'array', items: { type: 'string' } },
						},
						required: ['builders', 'files'],
						additionalProperties: false,
					},
					allow: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								sites: { type: 'array', items: { type: 'string' } },
								reason: { type: 'string', minLength: 1 },
							},
							required: ['sites', 'reason'],
							additionalProperties: false,
						},
					},
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const options = context.options[0] as Options | undefined;
		const filename = slashed(context.filename);
		if (!options || !inScope(filename, options)) return {};
		const flags = new Set(
			(options.families ?? [])
				.filter(({ files }) => matchesAny(filename, files))
				.map(({ flag }) => flag)
		);
		const bare =
			options.bareBuilders && matchesAny(filename, options.bareBuilders.files)
				? new Set(options.bareBuilders.builders)
				: new Set<string>();
		// `<path>:<name>` sites whose path names this file, by name.
		const allowedHere = new Map<string, string>();
		for (const { sites } of options.allow ?? []) {
			for (const site of sites) {
				const separator = site.lastIndexOf(':');
				if (matchesAny(filename, [site.slice(0, separator)])) {
					allowedHere.set(site.slice(separator + 1), site);
				}
			}
		}
		if (flags.size === 0 && bare.size === 0 && allowedHere.size === 0) return {};

		const used = new Set<string>();
		const finding = (node: AstNode, name: string, message: string) => {
			if (allowedHere.has(name)) {
				used.add(name);
				return;
			}
			context.report({ node, message });
		};

		return {
			CallExpression(node) {
				if (flags.size === 0) return;
				if (resolvedName(context, node.callee as AstNode) !== 'assertFeatureEnabled') return;
				const flag = staticString((node.arguments as AstNode[])[1]);
				if (flag === undefined || !flags.has(flag)) return;
				const name = topLevelName(node);
				finding(
					node,
					name,
					`\`${name}\` asserts '${flag}' by hand inside its gated family. Use the family's featureGated builder (see CONVENTIONS.md, "Feature-flag floors") so the floor cannot be forgotten. Only a soft-auth publicQuery marked \`// flag-inline:\` or a module serving another surface may be listed under "allow" in oxlintrc.json, with its reason.`
				);
			},
			'Program:exit'(program: AstNode) {
				if (bare.size > 0) {
					const table = builderTableFor(context);
					if (table) {
						for (const definition of registeredFunctions(context, table, program)) {
							if (!bare.has(definition.builder.name)) continue;
							finding(
								definition.nameNode,
								definition.name,
								`\`${definition.name}\` is built with ${definition.builder.name}, skipping its family's feature floor. Use the family's featureGated builder (postboxQuery / postboxMutation, externalMail*, …; see CONVENTIONS.md, "Feature-flag floors").`
							);
						}
					}
				}
				for (const [name, site] of allowedHere) {
					if (used.has(name)) continue;
					context.report({
						loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
						message: `\`${name}\`: stale owlat/feature-floor-in-builder exemption ${site} in oxlintrc.json; nothing here reports it any more. Delete the site.`,
					});
				}
			},
		};
	},
};

export default rule;
