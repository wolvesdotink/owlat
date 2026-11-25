import { relative } from 'node:path';
import type { PluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { PluginCliError } from './errors';
import { toPosix } from './paths';
import { minimalFiles } from './scaffoldMinimal';
import { SEND_PROVIDER_MODULE_EXPORTS, sendProviderFiles } from './scaffoldSendProvider';
import { sendProviderNames } from './scaffoldSendProviderNames';

/** One scaffolded file, keyed by its POSIX path relative to the plugin directory. */
export type ScaffoldFiles = ReadonlyMap<string, string>;

/**
 * Where the package lands.
 *
 *  - `workspace`  inside the checkout `create` runs in: a workspace member that
 *                 resolves the kit through `workspace:*` and reaches the shared
 *                 tsconfig and lint config by relative path.
 *  - `standalone` outside it, for a plugin kept in its own repository: a
 *                 self-contained package that installs `@owlat/plugin-kit` from
 *                 npm, so it names real version ranges and no checkout path.
 */
export type ScaffoldLayout = 'workspace' | 'standalone';

/**
 * The version ranges a standalone package names, read from the checkout that
 * runs `create`. The kit range is the checkout's own kit version, because the
 * release that carries this checkout's code publishes the kit at that version.
 */
export interface StandaloneVersions {
	readonly pluginKit: string;
	readonly typesNode: string;
	readonly typescript: string;
	readonly vitest: string;
	readonly oxlint: string;
}

/**
 * The templates `create` can emit.
 *
 *  - `minimal`       an empty manifest declaring nothing. The default, because
 *                    most plugins contribute something other than a transport
 *                    and every bucket is one `contributes` key away.
 *  - `send-provider` a complete send-transport bundle:
 *                    send module, feedback webhook, sending-domain identity,
 *                    capability declarations, credential form and test stubs.
 *                    Emitted whole rather than in pieces because the halves are
 *                    joined — a webhook without its signature contract, or an
 *                    identity without a required variable, is refused at manifest
 *                    validation, so a partial skeleton would not compose.
 */
export const SCAFFOLD_TEMPLATES = ['minimal', 'send-provider'] as const;

export type ScaffoldTemplate = (typeof SCAFFOLD_TEMPLATES)[number];

export const DEFAULT_SCAFFOLD_TEMPLATE: ScaffoldTemplate = 'minimal';

/**
 * Everything that differs between templates, in ONE record per template.
 *
 * A template answers three questions — which module exports to merge, which
 * file set to emit, and which completion hint `create` prints. Spread over
 * separate comparisons, a missed hint prints the minimal one for a bundle and
 * missed exports emit a manifest naming export paths the `package.json` does not
 * declare (a failure that surfaces only at install-time provenance
 * verification, nowhere in this repository's tests). The record is typed
 * `Record<ScaffoldTemplate, …>`, so a template added to the list above does not
 * compile until it answers all three questions here.
 */
interface ScaffoldTemplateDefinition {
	/**
	 * The package's non-root `exports`, one per contribution module the template's
	 * manifest names. Codegen imports a contribution's executable half through a
	 * condition-independent package export STRING, so the module map and the
	 * package's `exports` have to be one declaration.
	 */
	readonly moduleExports: Readonly<Record<string, string>>;
	/** The files this template adds on top of the shared package skeleton. */
	readonly files: (
		id: PluginId,
		packageName: PluginPackageName,
		layout: ScaffoldLayout
	) => ReadonlyMap<string, string>;
	/** What `create` prints once the package is on disk. */
	readonly completionHint: string;
}

export const SCAFFOLD_TEMPLATE_DEFINITIONS: Readonly<
	Record<ScaffoldTemplate, ScaffoldTemplateDefinition>
> = Object.freeze({
	minimal: {
		moduleExports: {},
		files: minimalFiles,
		completionHint:
			'Declare capabilities and contributions in src/manifest.ts, then run its tests.',
	},
	'send-provider': {
		moduleExports: SEND_PROVIDER_MODULE_EXPORTS,
		files: (id, packageName, layout) =>
			sendProviderFiles(sendProviderNames(id), packageName, layout),
		completionHint:
			'Fill in the TODOs in src/convex/, then run its tests. See /developer/plugin-send-providers.',
	},
});

/** Narrow a `--template` argument, naming the accepted set on a miss. */
export function parseScaffoldTemplate(input: string): ScaffoldTemplate {
	if ((SCAFFOLD_TEMPLATES as readonly string[]).includes(input)) return input as ScaffoldTemplate;
	throw new PluginCliError(`Unknown template: ${input}`, [
		`Run one of: ${SCAFFOLD_TEMPLATES.join(', ')}`,
	]);
}

/**
 * Build the deterministic file set for a new plugin package. Content is a pure
 * function of the plugin id, package name, chosen template, and either the
 * target directory's position within the workspace (which fixes the relative
 * paths to the shared tsconfig, lint config, and `@owlat/plugin-kit` source) or,
 * for a standalone package, the version ranges it names — no timestamps or
 * randomness — so re-running `create` on an unchanged input yields
 * byte-identical files. Passing `standalone` selects the standalone layout.
 */
export function buildScaffold(
	workspaceRoot: string,
	targetDir: string,
	id: PluginId,
	packageName: PluginPackageName,
	template: ScaffoldTemplate = DEFAULT_SCAFFOLD_TEMPLATE,
	standalone?: StandaloneVersions
): ScaffoldFiles {
	const toRoot = toPosix(relative(targetDir, workspaceRoot)) || '.';
	const definition = SCAFFOLD_TEMPLATE_DEFINITIONS[template];
	const layout: ScaffoldLayout = standalone === undefined ? 'workspace' : 'standalone';
	const files = new Map<string, string>();

	const manifestJson = JSON.stringify(
		standalone === undefined
			? packageJson(packageName, toRoot, definition.moduleExports)
			: standalonePackageJson(packageName, definition.moduleExports, standalone),
		null,
		'\t'
	);

	// THE PACKAGE SKELETON, identical at every template: the build wiring, and
	// nothing a template's content decides. The authoring guide's file table names
	// these three as the skeleton and lists the template's own files separately, so
	// what is emitted here and what is emitted below stay distinguishable.
	files.set('package.json', `${manifestJson}\n`);
	files.set(
		'tsconfig.json',
		`${JSON.stringify(standalone === undefined ? tsconfig(toRoot) : standaloneTsconfig(), null, '\t')}\n`
	);
	files.set(
		'vitest.config.ts',
		standalone === undefined ? vitestConfig(toRoot) : STANDALONE_VITEST_CONFIG
	);

	for (const [path, content] of definition.files(id, packageName, layout)) {
		files.set(path, content);
	}

	return files;
}

function packageJson(
	packageName: PluginPackageName,
	toRoot: string,
	moduleExports: Readonly<Record<string, string>>
): Record<string, unknown> {
	return {
		name: packageName,
		version: '0.0.0',
		// PRIVATE AT EVERY TEMPLATE. A package scaffolded INTO THIS WORKSPACE (the
		// default, `examples/plugins/<id>`) is a workspace member, and a non-private
		// one would be version-bumped by `release:cut` and publishable alongside the
		// real packages — a half-finished scaffold on npm under the workspace scope.
		//
		// It is also the honest state of the artifact: the manifest below carries
		// `workspace:*` and `catalog:` specifiers, and the tsconfig and lint script
		// reach back into this checkout by relative path. Publishing is the last step
		// of MOVING THE PACKAGE OUT, and the emitted README says so at the line that
		// tells an author to publish.
		private: true,
		type: 'module',
		exports: { '.': './src/index.ts', ...moduleExports },
		scripts: {
			test: 'vitest run',
			'test:watch': 'vitest watch',
			lint: `oxlint --config ${toRoot}/oxlintrc.json src`,
			typecheck: 'tsc --noEmit',
		},
		dependencies: { '@owlat/plugin-kit': 'workspace:*' },
		devDependencies: {
			'@types/node': 'catalog:',
			typescript: 'catalog:',
			vitest: 'catalog:',
		},
	};
}

function tsconfig(toRoot: string): Record<string, unknown> {
	return {
		extends: `${toRoot}/tsconfig.base.json`,
		compilerOptions: {
			importHelpers: false,
			types: ['node'],
			lib: ['ES2023', 'DOM'],
			noEmit: true,
			paths: {
				'@owlat/plugin-kit': [`${toRoot}/packages/plugin-kit/src/index.ts`],
				'@owlat/provider-kit': [`${toRoot}/packages/provider-kit/src/index.ts`],
			},
		},
		include: ['src/**/*.ts'],
		exclude: ['node_modules', 'dist'],
	};
}

function vitestConfig(toRoot: string): string {
	return `import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
	},
	resolve: {
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, '${toRoot}/packages/plugin-kit/src/index.ts'),
			'@owlat/provider-kit': resolve(__dirname, '${toRoot}/packages/provider-kit/src/index.ts'),
		},
	},
});
`;
}

/**
 * The standalone package names real ranges where the workspace one names
 * `workspace:*` and `catalog:`. It stays private for the same reason as the
 * workspace layout's README gives: publishing is a deliberate step, taken by
 * deleting the flag.
 */
function standalonePackageJson(
	packageName: PluginPackageName,
	moduleExports: Readonly<Record<string, string>>,
	versions: StandaloneVersions
): Record<string, unknown> {
	return {
		name: packageName,
		version: '0.0.0',
		private: true,
		type: 'module',
		exports: { '.': './src/index.ts', ...moduleExports },
		scripts: {
			test: 'vitest run',
			'test:watch': 'vitest watch',
			lint: 'oxlint src',
			typecheck: 'tsc --noEmit',
		},
		dependencies: { '@owlat/plugin-kit': versions.pluginKit },
		devDependencies: {
			'@types/node': versions.typesNode,
			oxlint: versions.oxlint,
			typescript: versions.typescript,
			vitest: versions.vitest,
		},
	};
}

/** The workspace base config's checks, inlined: nothing here reaches a checkout. */
function standaloneTsconfig(): Record<string, unknown> {
	return {
		compilerOptions: {
			target: 'ESNext',
			module: 'ESNext',
			moduleResolution: 'bundler',
			strict: true,
			skipLibCheck: true,
			esModuleInterop: true,
			isolatedModules: true,
			forceConsistentCasingInFileNames: true,
			noUncheckedIndexedAccess: true,
			noPropertyAccessFromIndexSignature: true,
			useUnknownInCatchVariables: true,
			types: ['node'],
			lib: ['ES2023', 'DOM'],
			noEmit: true,
		},
		include: ['src/**/*.ts'],
		exclude: ['node_modules', 'dist'],
	};
}

const STANDALONE_VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
	},
});
`;
