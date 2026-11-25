import type { PluginPackageName } from '@owlat/plugin-host';
import { CLI_INVOCATION } from './command';
import type { ScaffoldLayout } from './scaffold';

/**
 * The README section every template ends with: how the scaffolded package gets
 * into a deployment. A workspace package's section points at `add` rather than
 * repeating its steps, because `add` prints them with this package's directory,
 * version and scope filled in, and a copy here would drift from the one the
 * command prints. A standalone package is not a workspace member, so `add`
 * prints nothing for it and the section carries the commands itself.
 */
export function bundlingReadmeSection(
	packageName: PluginPackageName,
	layout: ScaffoldLayout = 'workspace'
): string {
	if (layout === 'standalone') return standaloneBundlingSection(packageName);
	return `## Bundling it into a deployment

Codegen bundles a plugin only when it is installed from a package registry and
pinned in \`bun.lock\`, so this folder cannot be bundled as it is. Run this from
the checkout root:

\`\`\`sh
${CLI_INVOCATION} add ${packageName}
\`\`\`

It refuses this workspace package and prints the commands that publish it, take
the folder out of the checkout and install the published version. The folder has
to leave because Bun links a workspace folder in place of the published package
of the same name. \`bun publish\` replaces the \`workspace:*\` and \`catalog:\`
ranges with real versions, but delete \`"private": true\` from \`package.json\`
first: a registry refuses a private package. After the install, run the same
\`add\` again and then \`bun run plugins:codegen\`.

Outside the checkout, \`tsconfig.json\`, \`vitest.config.ts\` and the \`lint\` script
still point into it by relative path. Building a Plugin, step 6, in the developer
docs walks through every step.
`;
}

const OWLAT_SCOPE = '@owlat/';

function standaloneBundlingSection(packageName: PluginPackageName): string {
	// The default name is in the Owlat project's own npm scope, which an author
	// cannot publish to; `add` on a workspace package suggests the same rename.
	const ownedScope = !packageName.startsWith(OWLAT_SCOPE);
	const publishedName = ownedScope
		? packageName
		: `@your-scope/${packageName.slice(OWLAT_SCOPE.length)}`;
	const rename = ownedScope ? '' : `npm pkg set name=${publishedName}\n`;
	const renameNote = ownedScope
		? ''
		: ` The \`@owlat\` scope belongs to the Owlat project: replace \`@your-scope\`
with an npm scope you can publish to.`;
	return `## Bundling it into a deployment

Codegen bundles a plugin only when it is installed from a package registry and
pinned in \`bun.lock\`. Publish this package from its own folder. Delete
\`"private": true\` first: a registry refuses a private package.${renameNote}

\`\`\`sh
${rename}npm pkg delete private
bun publish --access public
\`\`\`

Then, from the root of the Owlat checkout that builds your deployment:

\`\`\`sh
bun add --exact ${publishedName}@0.0.0
${CLI_INVOCATION} add ${publishedName}
bun run plugins:codegen
\`\`\`

\`0.0.0\` is the version \`create\` wrote; for a later release, run
\`npm pkg set version=<version>\` before \`bun publish\` and install that
version. Building a Plugin, step 6, in the developer docs explains each step.
`;
}
