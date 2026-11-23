import type { PluginPackageName } from '@owlat/plugin-host';
import { CLI_INVOCATION } from './command';

/**
 * The README section every template ends with: how the scaffolded package gets
 * into a deployment. It points at `add` rather than repeating its steps, because
 * `add` prints them with this package's directory, version and scope filled in,
 * and a copy here would drift from the one the command prints.
 */
export function bundlingReadmeSection(packageName: PluginPackageName): string {
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
