import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginPackageName } from '@owlat/plugin-host';
import { CLI_INVOCATION } from './command';
import { PluginCliError } from './errors';

export interface WorkspacePackage {
	/** POSIX path relative to the workspace root. */
	readonly directory: string;
	readonly version: string;
	readonly private: boolean;
}

const MAX_MEMBERS_PER_PATTERN = 1024;

/**
 * Find the workspace member that declares `packageName`, reading the root
 * `workspaces` globs as data. Only the two shapes the root manifest uses are
 * understood, `dir` and `dir/*`; any other pattern is skipped, which can only
 * miss a member, never invent one.
 */
export async function findWorkspacePackage(
	workspaceRoot: string,
	packageName: PluginPackageName
): Promise<WorkspacePackage | undefined> {
	const root = await readJson(join(workspaceRoot, 'package.json'));
	const workspaces = isRecord(root) ? root['workspaces'] : undefined;
	const patterns = Array.isArray(workspaces)
		? workspaces
		: isRecord(workspaces) && Array.isArray(workspaces['packages'])
			? workspaces['packages']
			: [];
	const excluded = new Set(
		patterns
			.filter(
				(pattern): pattern is string => typeof pattern === 'string' && pattern.startsWith('!')
			)
			.map((pattern) => pattern.slice(1))
	);

	for (const pattern of patterns) {
		if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
		for (const directory of await expand(workspaceRoot, pattern)) {
			if (excluded.has(directory)) continue;
			const member = await readJson(join(workspaceRoot, ...directory.split('/'), 'package.json'));
			if (!isRecord(member) || member['name'] !== packageName) continue;
			return {
				directory,
				version: typeof member['version'] === 'string' ? member['version'] : '0.0.0',
				private: member['private'] === true,
			};
		}
	}
	return undefined;
}

async function expand(workspaceRoot: string, pattern: string): Promise<readonly string[]> {
	if (!pattern.endsWith('/*')) return pattern.includes('*') ? [] : [pattern];
	const parent = pattern.slice(0, -2);
	if (parent.includes('*')) return [];
	try {
		const entries = await readdir(join(workspaceRoot, ...parent.split('/')), {
			withFileTypes: true,
		});
		return entries
			.filter((entry) => entry.isDirectory())
			.slice(0, MAX_MEMBERS_PER_PATTERN)
			.map((entry) => `${parent}/${entry.name}`);
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return undefined;
	}
}

const OWLAT_SCOPE = '@owlat/';

/**
 * The refusal `add` raises for a workspace package, with the exact commands
 * that turn it into one codegen accepts. Codegen bundles only registry installs
 * pinned by integrity in `bun.lock`, so the way forward is to publish, never to
 * point the config at the folder.
 */
export function workspacePackageRefusal(
	packageName: PluginPackageName,
	member: WorkspacePackage
): PluginCliError {
	const ownedScope = !packageName.startsWith(OWLAT_SCOPE);
	const publishedName = ownedScope
		? packageName
		: `@your-scope/${packageName.slice(OWLAT_SCOPE.length)}`;
	const folder = member.directory.split('/').at(-1) ?? member.directory;
	return new PluginCliError(
		`${packageName} is the workspace package in ${member.directory}. A bundled plugin has to be installed from a package registry.`,
		[
			'From the checkout root, publish it, take the folder out of the checkout and install the published version:',
			`  cd ${member.directory}`,
			...(ownedScope ? [] : [`  npm pkg set name=${publishedName}`]),
			...(member.private ? ['  npm pkg delete private'] : []),
			'  bun publish --access public',
			'  cd -',
			`  mv ${member.directory} ../${folder}`,
			`  bun add --exact ${publishedName}@${member.version}`,
			`  ${CLI_INVOCATION} add ${publishedName}`,
			...(ownedScope
				? []
				: [
						'The @owlat scope belongs to the Owlat project: replace @your-scope with an npm scope you can publish to.',
					]),
			'The folder has to leave the checkout because Bun links a workspace folder in place of the published package of the same name.',
			'Building a Plugin, step 6, explains each step.',
		]
	);
}
