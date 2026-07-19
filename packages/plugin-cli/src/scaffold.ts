import { relative } from 'node:path';
import type { PluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { toPosix } from './paths';

/** One scaffolded file, keyed by its POSIX path relative to the plugin directory. */
export type ScaffoldFiles = ReadonlyMap<string, string>;

/**
 * Build the deterministic file set for a new plugin package. Content is a pure
 * function of the plugin id, package name, and the target directory's position
 * within the workspace (which fixes the relative paths to the shared tsconfig,
 * lint config, and `@owlat/plugin-kit` source) — no timestamps or randomness —
 * so re-running `create` on an unchanged input yields byte-identical files.
 */
export function buildScaffold(
	workspaceRoot: string,
	targetDir: string,
	id: PluginId,
	packageName: PluginPackageName
): ScaffoldFiles {
	const toRoot = toPosix(relative(targetDir, workspaceRoot)) || '.';
	const exportName = `${toCamelCase(id)}Plugin`;
	const files = new Map<string, string>();

	files.set('package.json', `${JSON.stringify(packageJson(packageName, toRoot), null, '\t')}\n`);
	files.set('tsconfig.json', `${JSON.stringify(tsconfig(toRoot), null, '\t')}\n`);
	files.set('vitest.config.ts', vitestConfig(toRoot));
	files.set('README.md', readme(id, packageName));
	files.set('src/manifest.ts', manifestSource(id, exportName));
	files.set('src/index.ts', indexSource(exportName));
	files.set('src/__tests__/manifest.test.ts', manifestTest(id, exportName));

	return files;
}

/** Derive a lowerCamelCase identifier from a validated kebab-case plugin id. */
export function toCamelCase(id: string): string {
	return id.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function packageJson(packageName: PluginPackageName, toRoot: string): Record<string, unknown> {
	return {
		name: packageName,
		version: '0.0.0',
		private: true,
		type: 'module',
		exports: { '.': './src/index.ts' },
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
