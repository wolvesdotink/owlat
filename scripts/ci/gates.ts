/**
 * The root lint gates and plugin smokes, in the order CI runs them, with the
 * inputs that make each one worth running for a given change.
 *
 * `scripts/ci-gate.sh` (CI's lint job and `ci:verify`) reads the command lists
 * from here, so it always runs every entry. `bun run check:changed` reads the
 * inputs and runs only the entries a change can affect. A gate added to the
 * lint chain therefore has to be added here, with its inputs, or neither runs
 * it; scripts/__tests__/ci-gates.test.ts fails when a root `lint:*` script is
 * missing from this list.
 *
 * Inputs are repo-relative path patterns (see `pathPattern` in selection.ts:
 * a trailing `/` is a directory, `*`, `**` and `{a,b}` are globs, anything else
 * an exact path) and, for gates that read the source of a workspace and its
 * dependencies, workspace names that select the gate when turbo reports them as
 * affected. A gate's own scripts count with every script they run and module
 * they import. Err wide: a missed input lets a red gate through to CI, an extra
 * one costs a few seconds.
 */

export interface GateInputs {
	readonly paths: readonly string[];
	readonly packages?: readonly string[];
}

export interface RootGate extends GateInputs {
	/** `lint:<name>` in the root package.json. */
	readonly name: string;
	/** What CI runs; `bun run lint:<name>` when absent. */
	readonly command?: readonly string[];
	/**
	 * For a gate that compares the tree with a base commit: the environment
	 * variable that sets that base. check:changed sets it to its own merge base
	 * (and unsets GITHUB_BASE_REF, which some gates prefer), so the gate checks
	 * the same change the rest of the run does.
	 */
	readonly baseEnv?: string;
}

export interface PluginSmoke extends GateInputs {
	readonly name: string;
	readonly command: readonly string[];
}

/** Changing one of these can change the result of every gate. */
export const GATE_GLOBAL_INPUTS = ['package.json', 'bun.lock'] as const;

const CODE = '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}';
const ANYWHERE = '**';
const CODE_ANYWHERE = `**/${CODE}`;
const RATCHET = 'scripts/ratchet.sh';

/**
 * Everything the plugin composition, its codegen and the Convex bundle are
 * built from. `@owlat/api` being affected also covers every workspace the
 * backend imports, since turbo marks a package affected when a dependency is.
 */
export const PLUGIN_GRAPH_INPUTS: GateInputs = {
	paths: [
		'apps/api/',
		'packages/plugin-codegen/',
		'packages/plugin-cli/',
		'packages/plugin-host/',
		'packages/plugin-kit/',
		'packages/provider-kit/',
		'examples/plugins/',
		'plugins.config.ts',
		'turbo.json',
	],
	packages: [
		'@owlat/api',
		'@owlat/plugin-codegen',
		'@owlat/plugin-cli',
		'@owlat/plugin-host',
		'@owlat/plugin-kit',
		'@owlat/provider-kit',
	],
};

/**
 * CI order matters: the API graph smoke and the clean-checkout smoke each
 * delete packages/plugin-kit/dist, and the clean-checkout smoke's
 * `plugins:check` is the one build the later entries (and the
 * `plugin-imports` gate) read.
 */
export const PLUGIN_SMOKES: readonly PluginSmoke[] = [
	{ name: 'api-graph', command: ['bun', 'run', 'plugins:test-api-graph'], ...PLUGIN_GRAPH_INPUTS },
	{
		name: 'deploy-graph',
		command: ['bun', 'run', 'plugins:test-deploy-graph'],
		...PLUGIN_GRAPH_INPUTS,
	},
	{ name: 'clean-checkout', command: ['bun', 'run', 'plugins:test-clean'], ...PLUGIN_GRAPH_INPUTS },
	{
		name: 'convex-bundle',
		command: ['node', 'packages/plugin-codegen/scripts/convexBundleSmoke.ts'],
		...PLUGIN_GRAPH_INPUTS,
	},
	{
		name: 'convex-function-graph',
		command: ['bun', 'packages/plugin-codegen/scripts/convexFunctionGraphSmoke.ts'],
		...PLUGIN_GRAPH_INPUTS,
	},
];

export const ROOT_GATES: readonly RootGate[] = [
	{
		name: 'warnings',
		paths: [
			`{apps,packages,scripts,examples}/**/${CODE}`,
			'oxlintrc.json',
			'**/.oxlintrc.json',
			// the Convex rules read the builder classification there
			'apps/api/scripts/lib/convex-builders.sh',
		],
	},
	{
		// Lints the same tree as `warnings` with the owlat rules, whose source
		// (packages/oxlint-plugin-owlat) the code glob already covers.
		name: 'owlat',
		paths: [
			`{apps,packages,scripts,examples}/**/${CODE}`,
			'oxlintrc.json',
			'**/.oxlintrc.json',
			'scripts/check-owlat-lint.sh',
			'scripts/owlat-lint-baseline.txt',
			'apps/api/scripts/lib/convex-builders.sh',
			RATCHET,
		],
	},
	{ name: 'scripts', paths: [`scripts/**/${CODE}`, 'oxlintrc.json'] },
	{
		// The gate scripts' own unit tests, plus the ones that read real repo
		// configuration (the turbo graph, workflows, compose files, manifests).
		name: 'script-tests',
		paths: [
			'scripts/',
			'.github/',
			'docker/',
			'infra/',
			'patches/',
			'docker-compose*.yml',
			'**/Dockerfile',
			'**/*.Dockerfile',
			'**/package.json',
			'install.sh',
			'turbo.json',
			'tsconfig.base.json',
			// The config this suite runs under.
			'vitest.config.ts',
			'vitest.shared.ts',
			'vitest.timeouts.ts',
			'oxlintrc.json',
			'oxfmtrc.json',
			'knip.jsonc',
			'plugins.config.ts',
			'apps/web/nuxt.config.ts',
		],
		packages: ['@owlat/shared'],
	},
	{
		// knip walks the whole monorepo, and the shared-export ratchet counts
		// production callers anywhere, so any source or manifest edit counts.
		name: 'deadcode',
		paths: [
			CODE_ANYWHERE,
			'**/package.json',
			'**/tsconfig*.json',
			'knip.jsonc',
			'scripts/check-dead-code.sh',
			'scripts/check-shared-production-exports.sh',
			RATCHET,
		],
	},
	{ name: 'catalog', paths: ['**/package.json', 'scripts/check-catalog-usage.sh'] },
	{
		name: 'build-graph',
		paths: [
			'**/package.json',
			'turbo.json',
			'packages/provider-kit/',
			'packages/plugin-kit/',
			'scripts/check-build-graph.ts',
			'scripts/json.ts',
			'scripts/package-manifest.ts',
			'scripts/turbo-json.ts',
		],
	},
	{
		name: 'convex-orphans',
		paths: [
			'apps/api/convex/',
			'apps/web/',
			'apps/code-worker/src/',
			'scripts/check-convex-plugin-orphans.ts',
		],
	},
	{
		name: 'convex-globals',
		paths: [
			'apps/api/convex/',
			'packages/*/src/',
			'packages/*/package.json',
			'scripts/check-convex-node-globals.ts',
		],
	},
	{
		name: 'filesize',
		paths: ['{apps,packages}/**/*.{ts,vue}', 'scripts/check-file-size.sh', RATCHET],
	},
	// Scans every tracked file.
	{ name: 'branding', paths: [ANYWHERE] },
	{
		name: 'format',
		paths: [CODE_ANYWHERE, 'oxfmtrc.json', 'scripts/check-format.sh'],
		baseEnv: 'OXFMT_BASE',
	},
	{
		// Reads every comment in the tree, in code, shell and YAML.
		name: 'comment-policy',
		paths: [
			CODE_ANYWHERE,
			'**/*.{sh,bash,yml,yaml}',
			'scripts/check-comment-policy.ts',
			'scripts/comment-policy.ts',
		],
	},
	{
		name: 'imports',
		paths: [CODE_ANYWHERE, '**/package.json', 'scripts/check-cross-package-imports.sh'],
	},
	{
		name: 'providers',
		paths: [
			'{apps,packages,examples}/**/*.{ts,tsx,vue}',
			'scripts/check-provider-identity.sh',
			'scripts/provider-identity-collisions.txt',
		],
	},
	{ name: 'ui-controls', paths: ['apps/web/app/', 'scripts/check-ui-controls.ts'] },
	{
		name: 'native-title',
		paths: [
			'apps/web/app/',
			'apps/marketing/',
			'apps/docs/',
			'packages/ui/',
			'packages/email-builder/src/',
			'scripts/check-native-title.sh',
			'scripts/native-title-findings.ts',
			RATCHET,
		],
	},
	{
		name: 'desktop-invoke',
		paths: [
			'apps/desktop/src/',
			'apps/desktop/src-tauri/',
			'apps/web/app/',
			'scripts/check-desktop-invoke-contract.ts',
			'scripts/desktop-invoke-scan.ts',
			'scripts/desktop-invoke-vue.ts',
			'scripts/json.ts',
		],
	},
	{
		name: 'page-headers',
		paths: ['apps/web/app/', 'scripts/check-page-headers.sh', RATCHET],
	},
	{
		name: 'tokens',
		paths: [
			'apps/web/app/',
			'packages/ui/',
			'scripts/check-palette-classes.ts',
			'scripts/check-token-contrast.ts',
		],
	},
	{
		name: 'member-jargon',
		paths: ['apps/web/app/', 'apps/web/i18n/', 'scripts/check-member-jargon.ts'],
	},
	{
		name: 'docker-workspaces',
		paths: [
			'**/package.json',
			'**/tsconfig*.json',
			'**/Dockerfile',
			'**/*.Dockerfile',
			'patches/',
			'scripts/check-docker-workspaces.sh',
		],
	},
	{
		name: 'deploy-closure',
		paths: [
			'apps/api/convex/',
			'apps/api/package.json',
			'packages/',
			'docker/',
			'scripts/check-deploy-image-closure.ts',
		],
	},
	{
		name: 'installer',
		paths: [
			'install.sh',
			'scripts/owlat',
			'apps/setup-cli/src/',
			'scripts/check-installer-invariants.sh',
		],
	},
	{
		// Reads the compose stacks, env templates, image manifests and
		// Dockerfiles, and imports the feature-flag registry.
		name: 'compose',
		paths: [
			'docker-compose*.yml',
			'.env*',
			'apps/*/.env*',
			'infra/',
			'docker/',
			'**/Dockerfile',
			'**/*.Dockerfile',
			'apps/updater/src/',
			'packages/shared/src/',
			'scripts/check-compose-invariants.sh',
			'scripts/check-docker-proxy-network.ts',
			'scripts/compose-schema-keys.ts',
			'scripts/docker-socket-access.ts',
			'scripts/gen-release-compose.sh',
		],
	},
	{
		name: 'mail-services',
		paths: [
			'apps/mta/src/',
			'apps/imap/src/',
			'apps/mail-sync/src/',
			'apps/updater/src/',
			'apps/code-worker/src/',
			'scripts/check-mail-service-guards.sh',
		],
	},
	{
		name: 'html-to-text',
		paths: [
			'apps/api/convex/',
			'packages/shared/src/',
			'packages/mail-message/src/',
			'packages/email-renderer/src/',
			'scripts/check-html-to-text.sh',
			'scripts/html-to-text-baseline.txt',
			RATCHET,
		],
	},
	{
		name: 'crypto-primitives',
		paths: [`{apps,packages}/**/${CODE}`, 'scripts/check-crypto-primitives.sh'],
	},
	{
		// Runs the text gates the owlat boundary rules replace beside those rules
		// and diffs their findings, until the text gates are retired.
		name: 'ast-gate-parity',
		paths: [
			`{apps,packages}/**/${CODE}`,
			'oxlintrc.json',
			'apps/api/scripts/',
			'scripts/ast-gate-parity.ts',
			'scripts/check-crypto-primitives.sh',
			'scripts/json.ts',
			'scripts/lint-diagnostics.ts',
		],
	},
	// Scans every tracked source, config and doc file.
	{ name: 'source-bytes', paths: [ANYWHERE] },
	// Lists every tracked path, so any added file can trip it.
	{ name: 'no-pr-assets', paths: [ANYWHERE] },
	{
		name: 'stored-block-corpus',
		paths: ['packages/email-renderer/src/', 'scripts/check-stored-block-corpus.ts'],
		baseEnv: 'STORED_BLOCK_CORPUS_BASE',
	},
	{
		// `lint:plugin-imports` without its `plugins:prepare` prefix: the
		// clean-checkout smoke above has already built the contract packages.
		name: 'plugin-imports',
		command: ['bun', 'packages/plugin-codegen/src/cli.ts', '--boundaries-only'],
		...PLUGIN_GRAPH_INPUTS,
	},
];

/**
 * `typecheck:scripts` (CI's typecheck job): every TypeScript file under
 * scripts/, which also imports `@owlat/shared`.
 */
export const SCRIPTS_TYPECHECK_INPUTS: GateInputs = {
	paths: ['scripts/**/*.ts', 'scripts/tsconfig.json', 'tsconfig.base.json'],
	packages: ['@owlat/shared'],
};

export function gateCommand(gate: RootGate): readonly string[] {
	return gate.command ?? ['bun', 'run', `lint:${gate.name}`];
}

/** One command per line, for scripts/ci-gate.sh (`bun scripts/ci/gates.ts smokes|gates`). */
export function listCommands(kind: string): string {
	const commands =
		kind === 'smokes'
			? PLUGIN_SMOKES.map((smoke) => smoke.command)
			: kind === 'gates'
				? ROOT_GATES.map(gateCommand)
				: undefined;
	if (!commands) throw new Error(`usage: bun scripts/ci/gates.ts smokes|gates (got ${kind})`);
	for (const command of commands)
		if (command.some((arg) => !arg || /\s/.test(arg)))
			throw new Error(`Gate command arguments must be non-empty words: ${command.join(' ')}`);
	return commands.map((command) => command.join(' ')).join('\n');
}

if (import.meta.main) {
	process.stdout.write(`${listCommands(process.argv[2] ?? '')}\n`);
}
