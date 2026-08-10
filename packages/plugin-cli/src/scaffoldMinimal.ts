/**
 * The `minimal` scaffold template — an empty manifest and the one test that
 * proves it validates.
 *
 * Its own module for the reason the send-provider template has three: `scaffold.ts`
 * is the template REGISTRY and the package skeleton every template shares, not the
 * place each template's content is written. With both templates' content out of
 * it, the skeleton is the three files it emits and nothing else, which is what the
 * authoring guide's file table is checked against.
 */

import type { PluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { toCamelCase } from './names';

/** Every file the minimal template adds on top of the shared skeleton. */
export function minimalFiles(
	id: PluginId,
	packageName: PluginPackageName
): ReadonlyMap<string, string> {
	const exportName = `${toCamelCase(id)}Plugin`;
	const files = new Map<string, string>();
	files.set('README.md', readmeSource(id, packageName));
	files.set('src/manifest.ts', manifestSource(id, exportName));
	files.set('src/index.ts', indexSource(exportName));
	files.set('src/__tests__/manifest.test.ts', manifestTestSource(id, exportName));
	return files;
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

/**
 * THE PACKAGE'S ROOT VALUE, re-exported by \`src/index.ts\` as its DEFAULT: the
 * generated composition imports every plugin package by default import, so a
 * package with only a named export composes into \`undefined\`.
 */
export default ${exportName};
`;
}

function indexSource(exportName: string): string {
	return `export { ${exportName} } from './manifest';
export { default } from './manifest';
`;
}

function manifestTestSource(id: PluginId, exportName: string): string {
	return `import { parsePluginManifest } from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import ${exportName}Default, { ${exportName} } from '../manifest';

describe('${id} manifest', () => {
	it('is a valid plugin manifest declaring the ${id} id', () => {
		expect(parsePluginManifest(${exportName}).id).toBe('${id}');
	});

	it('is the package default export codegen imports it as', () => {
		// The generated composition writes \`import manifest from '<package>'\`, so a
		// package that only exported this by name would compose into \`undefined\`.
		expect(${exportName}Default).toBe(${exportName});
	});
});
`;
}

function readmeSource(id: PluginId, packageName: PluginPackageName): string {
	return `# ${packageName}

The \`${id}\` Owlat plugin.

The manifest in \`src/manifest.ts\` is the plugin's contract: declare each
capability and contribution there. Every contribution's executable half lives at
its \`module.exportPath\` and is imported by the generated composition as that
module's DEFAULT export; the host imports the manifest at build time but never
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
