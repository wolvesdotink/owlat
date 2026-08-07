import { relative } from 'node:path';
import type { PluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { PluginCliError } from './errors';
import { toCamelCase } from './names';
import { toPosix } from './paths';
import {
	SEND_PROVIDER_MODULE_EXPORTS,
	sendProviderFiles,
	sendProviderNames,
} from './scaffoldSendProvider';

/** One scaffolded file, keyed by its POSIX path relative to the plugin directory. */
export type ScaffoldFiles = ReadonlyMap<string, string>;

/**
 * The templates `create` can emit.
 *
 *  - `minimal`       an empty manifest declaring nothing. The default, because
 *                    most plugins contribute something other than a transport
 *                    and every bucket is one `contributes` key away.
 *  - `send-provider` a complete send-transport bundle (the seams plan's D4/P3.4):
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

/** Narrow a `--template` argument, naming the accepted set on a miss. */
export function parseScaffoldTemplate(input: string): ScaffoldTemplate {
	if ((SCAFFOLD_TEMPLATES as readonly string[]).includes(input)) return input as ScaffoldTemplate;
	throw new PluginCliError(`Unknown template: ${input}`, [
		`Run one of: ${SCAFFOLD_TEMPLATES.join(', ')}`,
	]);
}

/**
 * Build the deterministic file set for a new plugin package. Content is a pure
 * function of the plugin id, package name, chosen template, and the target
 * directory's position within the workspace (which fixes the relative paths to
 * the shared tsconfig, lint config, and `@owlat/plugin-kit` source) — no
 * timestamps or randomness — so re-running `create` on an unchanged input yields
 * byte-identical files.
 */
export function buildScaffold(
	workspaceRoot: string,
	targetDir: string,
	id: PluginId,
	packageName: PluginPackageName,
	template: ScaffoldTemplate = DEFAULT_SCAFFOLD_TEMPLATE
): ScaffoldFiles {
	const toRoot = toPosix(relative(targetDir, workspaceRoot)) || '.';
	const exportName = `${toCamelCase(id)}Plugin`;
	// A contribution's executable half is imported by codegen through a
	// condition-independent package export string, so the module map and the
	// package's `exports` are one declaration: a template that emitted a module
	// the package does not export would fail provenance verification at install
	// time rather than here.
	const moduleExports = template === 'send-provider' ? SEND_PROVIDER_MODULE_EXPORTS : {};
	const files = new Map<string, string>();

	const manifestJson = JSON.stringify(
		packageJson(packageName, toRoot, moduleExports, template === 'send-provider'),
		null,
		'\t'
	);

	files.set('package.json', `${manifestJson}\n`);
	files.set('tsconfig.json', `${JSON.stringify(tsconfig(toRoot), null, '\t')}\n`);
	files.set('vitest.config.ts', vitestConfig(toRoot));

	// The three files above are the package's build wiring and are identical at
	// every template; everything below is the template's own content.
	if (template === 'send-provider') {
		for (const [path, content] of sendProviderFiles(sendProviderNames(id), packageName)) {
			files.set(path, content);
		}
		return files;
	}

	files.set('README.md', readme(id, packageName));
	files.set('src/manifest.ts', manifestSource(id, exportName));
	files.set('src/index.ts', indexSource(exportName));
	files.set('src/__tests__/manifest.test.ts', manifestTest(id, exportName));

	return files;
}

function packageJson(
	packageName: PluginPackageName,
	toRoot: string,
	moduleExports: Readonly<Record<string, string>>,
	isPublishable: boolean
): Record<string, unknown> {
	return {
		name: packageName,
		version: '0.0.0',
		// PUBLISHABILITY IS A TEMPLATE DECISION. The minimal skeleton scaffolds into
		// `examples/plugins/` by default — a workspace package nobody publishes, and
		// `private` is what keeps an accidental `npm publish` from shipping it. A
		// send provider is the opposite case: the whole point of the tier is a bundle
		// that leaves this repository, and its own README's last instruction is to
		// publish it, which `private: true` refuses.
		...(isPublishable ? {} : { private: true }),
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
			paths: { '@owlat/plugin-kit': [`${toRoot}/packages/plugin-kit/src/index.ts`] },
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
		},
	},
});
`;
}

function manifestSource(id: PluginId, exportName: string): string {
	return `import { definePlugin } from '@owlat/plugin-kit';

/**
 * The ${id} plugin manifest: one \`definePlugin\` declaration that names every
 * capability this plugin may ever exercise and every contribution it makes.
 * The host derives permissions and the generated composition from this data
 * WITHOUT executing plugin code, so keep it a static, data-only declaration.
 */
export const ${exportName} = definePlugin({
	id: '${id}',
	version: '0.0.0',
	capabilities: [],
});
`;
}

function indexSource(exportName: string): string {
	return `export { ${exportName} } from './manifest';
`;
}

function manifestTest(id: PluginId, exportName: string): string {
	return `import { parsePluginManifest } from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import { ${exportName} } from '../manifest';

describe('${id} manifest', () => {
	it('is a valid plugin manifest declaring the ${id} id', () => {
		expect(parsePluginManifest(${exportName}).id).toBe('${id}');
	});
});
`;
}

function readme(id: PluginId, packageName: PluginPackageName): string {
	return `# ${packageName}

The \`${id}\` Owlat plugin.

The manifest in \`src/manifest.ts\` is the plugin's contract: declare each
capability and contribution there. Every contribution's executable half lives at
its \`module.exportPath\`; the host imports the manifest at build time but never
runs contribution code during codegen.

## Development

\`\`\`sh
# Type-check, lint, and test this package
bun run --cwd <path-to-this-package> typecheck
bun run --cwd <path-to-this-package> lint
bun run --cwd <path-to-this-package> test
\`\`\`

To bundle this plugin into a deployment, publish it and add its package name to
the workspace \`plugins.config.ts\` with \`owlat plugins add ${packageName}\`,
then regenerate the composition with \`owlat plugins codegen\`.
`;
}
