import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPackageLegalFiles, PACKAGE_LEGAL_FILES } from './packageLegalFiles';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'owlat-plugin-kit-'));
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
	name: string;
	version: string;
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

try {
	run('bun', ['pm', 'pack', '--destination', temporaryRoot], packageRoot);
	for (const file of PACKAGE_LEGAL_FILES) {
		if (existsSync(join(packageRoot, file))) {
			throw new Error(`Postpack did not remove staged ${file}`);
		}
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
void manifest;
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
