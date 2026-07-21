/**
 * Smoke-tests the *packaged* `@owlat/plugin-kit`: packs the tarball, installs it
 * into a throwaway consumer, and exercises the built artifact at runtime and
 * through `tsc`.
 *
 * It packs the dist/ that `@owlat/plugin-kit#build` already produced instead of
 * rebuilding it. `bun pm pack` would otherwise run `prepack`, which is
 * `bun run build` — a `tsup --clean` of the one shared artifact in this repo,
 * fired from a *test* task that turbo runs concurrently with every sibling
 * `test:coverage` job that imports @owlat/plugin-kit. `--ignore-scripts`
 * suppresses that; the legal files prepack would have staged are staged here
 * instead, and the mtime assertion below fails if anything reintroduces a
 * rebuild. See scripts/check-build-graph.ts for the guard that enforces this.
 */
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	cleanPackageLegalFiles,
	PACKAGE_LEGAL_FILES,
	stagePackageLegalFiles,
} from './packageLegalFiles';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'owlat-plugin-kit-'));
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
	name: string;
	version: string;
	scripts?: Record<string, string>;
};
const archiveName = `${packageMetadata.name.replace(/^@/, '').replaceAll('/', '-')}-${packageMetadata.version}.tgz`;
const archivePath = join(temporaryRoot, archiveName);
const consumerRoot = join(temporaryRoot, 'consumer');

function run(command: string, args: string[], cwd: string): string {
	return execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function runBytes(command: string, args: string[], cwd: string): Buffer {
	return execFileSync(command, args, {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

const distEntry = join(packageRoot, 'dist/index.js');
if (!existsSync(distEntry)) {
	throw new Error(
		'packages/plugin-kit/dist is missing. This smoke packs the artifact `@owlat/plugin-kit#build` produced; run `turbo run build --filter=@owlat/plugin-kit` first.'
	);
}
const distSignatureBeforePack = statSync(distEntry).mtimeMs;

// The pack below runs with --ignore-scripts, so assert the publish-time hooks it
// stands in for still do what this smoke simulates: stage the legal files, build
// the dist, and clean the staged copies again.
for (const [script, expected] of [
	['prepack', ['run build', 'packageLegalFiles.ts stage']],
	['postpack', ['packageLegalFiles.ts clean']],
] as const) {
	const command = packageMetadata.scripts?.[script] ?? '';
	for (const fragment of expected) {
		if (!command.includes(fragment)) {
			throw new Error(`Publish hook "${script}" no longer runs \`${fragment}\``);
		}
	}
}

try {
	stagePackageLegalFiles();
	run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', temporaryRoot], packageRoot);
	if (statSync(distEntry).mtimeMs !== distSignatureBeforePack) {
		throw new Error(
			'Packing rebuilt packages/plugin-kit/dist. This smoke must never write the shared artifact — it races every task that reads it.'
		);
	}

	const archiveFiles = run('tar', ['-tzf', archivePath], packageRoot).trim().split('\n');
	const requiredFiles = [
		'package/package.json',
		'package/README.md',
		'package/dist/index.js',
		'package/dist/index.js.map',
		'package/dist/index.d.ts',
		...PACKAGE_LEGAL_FILES.map((file) => `package/${file}`),
	];
	for (const file of requiredFiles) {
		if (!archiveFiles.includes(file)) throw new Error(`Package archive is missing ${file}`);
	}
	if (archiveFiles.some((file) => file.includes('__tests__') || file.startsWith('package/src/'))) {
		throw new Error('Package archive contains source tests or unbuilt source files');
	}
	for (const file of PACKAGE_LEGAL_FILES) {
		const packedContents = runBytes('tar', ['-xOzf', archivePath, `package/${file}`], packageRoot);
		const canonicalContents = readFileSync(join(repositoryRoot, file));
		if (!packedContents.equals(canonicalContents)) {
			throw new Error(`Packed ${file} differs from the repository canonical file`);
		}
	}

	mkdirSync(consumerRoot);
	writeFileSync(
		join(consumerRoot, 'package.json'),
		JSON.stringify({ name: 'plugin-kit-smoke', private: true, type: 'module' })
	);
	run('npm', ['install', '--ignore-scripts', '--no-package-lock', archivePath], consumerRoot);

	writeFileSync(
		join(consumerRoot, 'runtime.mjs'),
		`import {
  PLUGIN_CONTRIBUTION_KINDS,
  PluginManifestError,
  definePlugin,
  isPluginManifest,
  parsePluginManifest,
  validatePluginManifest,
} from '@owlat/plugin-kit';

const manifest = definePlugin({ id: 'node-smoke', version: '1.0.0', capabilities: [] });
if (!isPluginManifest(manifest)) throw new Error('type guard rejected a valid manifest');
if (!validatePluginManifest(manifest).ok) throw new Error('validator rejected a valid manifest');
const parsed = parsePluginManifest(manifest);
if (parsed === manifest) throw new Error('parser did not return a canonical snapshot');
if (!Object.isFrozen(parsed) || !Object.isFrozen(parsed.capabilities)) {
  throw new Error('parser snapshot is not immutable');
}
if (!PLUGIN_CONTRIBUTION_KINDS.includes('sendGates')) throw new Error('catalog export missing');
if (!(new PluginManifestError([]) instanceof Error)) throw new Error('error export missing');
`
	);
	run('node', ['runtime.mjs'], consumerRoot);

	writeFileSync(
		join(consumerRoot, 'consumer.ts'),
		`import {
  definePlugin,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type PluginCapability,
  type PluginAutonomyGateModule,
  type PluginCapabilityGrant,
  type PluginComponentDefinition,
  type PluginContext,
  type PluginContributionKind,
  type PluginContributions,
  type PluginFeatureFlagDefinition,
  type PluginLlmBudget,
  type PluginLlmGenerateRequest,
  type PluginLlmGenerateResult,
  type PluginLlmMessage,
  type PluginLlmService,
  type PluginLlmTier,
  type PluginLlmUsage,
  type PluginLogger,
  type PluginLogFields,
  type PluginManifest,
  type PluginManifestIssue,
  type PluginManifestIssueCode,
  type PluginManifestValidation,
  type PluginPermissionService,
  type PluginScheduledTask,
  type PluginSchedulerService,
  type PluginStorageListOptions,
  type PluginStorageListResult,
  type PluginStorageService,
} from '@owlat/plugin-kit';

const manifest: PluginManifest = definePlugin({
  id: 'typed-node-smoke',
  version: '1.0.0',
  capabilities: ['mail:read'],
});
const gate: PluginAutonomyGateModule = {
  async evaluate() { return { outcome: 'no-objection' }; },
};
void manifest;
void gate;
`
	);
	writeFileSync(
		join(consumerRoot, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
			},
			include: ['consumer.ts'],
		})
	);
	const typescriptBin = resolve(packageRoot, '../../node_modules/typescript/bin/tsc');
	run('node', [typescriptBin, '--project', 'tsconfig.json'], consumerRoot);

	const installedManifest = JSON.parse(
		readFileSync(join(consumerRoot, 'node_modules/@owlat/plugin-kit/package.json'), 'utf8')
	) as { exports?: Record<string, unknown> };
	if (!installedManifest.exports?.['.']) throw new Error('Installed package has no root export');
} finally {
	cleanPackageLegalFiles();
	rmSync(temporaryRoot, { recursive: true, force: true });
}
