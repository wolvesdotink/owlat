import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import ts from 'typescript';

export interface RepositoryModuleAlias {
	readonly specifierPattern: string;
	readonly targetPattern: string;
}

const SKIPPED_DIRECTORIES = new Set([
	'.git',
	'.nuxt',
	'.output',
	'.turbo',
	'coverage',
	'dist',
	'node_modules',
	'target',
]);

export async function readRepositoryModuleAliases(
	workspaceRoot: string
): Promise<readonly RepositoryModuleAlias[]> {
	const aliases: RepositoryModuleAlias[] = [];
	const configFiles = await findConfigFiles(workspaceRoot);
	for (const path of configFiles) {
		const source = await readFile(path, 'utf8');
		if (basename(path) === 'package.json') {
			collectPackageAliases(JSON.parse(source) as unknown, aliases);
		} else {
			const parsed = ts.parseConfigFileTextToJson(path, source);
			if (!parsed.error) collectTypeScriptAliases(parsed.config as unknown, aliases);
		}
	}
	return Object.freeze(aliases);
}

export function specifierTargetsConfiguredPackage(
	specifier: string,
	packageNames: readonly string[],
	aliases: readonly RepositoryModuleAlias[]
): boolean {
	const pending = [specifier];
	const visited = new Set<string>();
	while (pending.length > 0 && visited.size <= 64) {
		const candidate = pending.pop();
		if (!candidate || visited.has(candidate)) continue;
		visited.add(candidate);
		if (packageNames.some((packageName) => targetReferencesPackage(candidate, packageName))) {
			return true;
		}
		for (const alias of aliases) {
			const wildcard = matchAlias(alias.specifierPattern, candidate);
			if (wildcard !== undefined) {
				pending.push(alias.targetPattern.replaceAll('*', wildcard));
			}
		}
	}
	return false;
}

async function findConfigFiles(workspaceRoot: string): Promise<readonly string[]> {
	const files: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name));
				continue;
			}
			if (
				entry.isFile() &&
				(entry.name === 'package.json' || /^tsconfig(?:\.[^.]+)?\.json$/.test(entry.name))
			) {
				files.push(join(directory, entry.name));
			}
		}
	};
	await visit(workspaceRoot);
	return files;
}

function collectPackageAliases(value: unknown, aliases: RepositoryModuleAlias[]): void {
	if (!isRecord(value)) return;
	if (isRecord(value['imports'])) {
		for (const [specifierPattern, target] of Object.entries(value['imports'])) {
			for (const targetPattern of collectStringLeaves(target)) {
				aliases.push({ specifierPattern, targetPattern });
			}
		}
	}
	for (const dependencyField of ['dependencies', 'optionalDependencies'] as const) {
		const dependencies = value[dependencyField];
		if (!isRecord(dependencies)) continue;
		for (const [specifierPattern, target] of Object.entries(dependencies)) {
			if (typeof target === 'string' && target.startsWith('npm:')) {
				aliases.push({ specifierPattern, targetPattern: target.slice('npm:'.length) });
			}
		}
	}
}

function collectTypeScriptAliases(value: unknown, aliases: RepositoryModuleAlias[]): void {
	if (!isRecord(value) || !isRecord(value['compilerOptions'])) return;
	const paths = value['compilerOptions']['paths'];
	if (!isRecord(paths)) return;
	for (const [specifierPattern, targets] of Object.entries(paths)) {
		if (!Array.isArray(targets)) continue;
		for (const targetPattern of targets) {
			if (typeof targetPattern === 'string') aliases.push({ specifierPattern, targetPattern });
		}
	}
}

function collectStringLeaves(value: unknown): readonly string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
	if (isRecord(value)) return Object.values(value).flatMap(collectStringLeaves);
	return [];
}

function matchAlias(pattern: string, specifier: string): string | undefined {
	const wildcardIndex = pattern.indexOf('*');
	if (wildcardIndex < 0) return pattern === specifier ? '' : undefined;
	const prefix = pattern.slice(0, wildcardIndex);
	const suffix = pattern.slice(wildcardIndex + 1);
	return specifier.startsWith(prefix) && specifier.endsWith(suffix)
		? specifier.slice(prefix.length, specifier.length - suffix.length)
		: undefined;
}

function targetReferencesPackage(target: string, packageName: string): boolean {
	const normalized = target.replaceAll('\\', '/');
	return (
		normalized === packageName ||
		normalized.startsWith(`${packageName}/`) ||
		normalized.startsWith(`${packageName}@`) ||
		normalized.includes(`/node_modules/${packageName}/`) ||
		normalized.endsWith(`/node_modules/${packageName}`)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
