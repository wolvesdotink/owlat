/**
 * Follow the plugin authoring tutorial's shell commands in a disposable,
 * checkout-shaped directory.
 *
 * The plugin CLI and the codegen script run for real, in Bun child processes.
 * The three commands that need the network are modelled on what they leave on
 * disk: `bun publish` puts the packed package into an in-memory registry (and
 * refuses a private package, as a registry does), `bun add --exact` installs from
 * it through `installFromRegistry`, and both resolve names the way Bun does,
 * including linking a workspace folder in place of a published package of the
 * same name. Any other command fails the run, so a tutorial edit that adds a
 * step this runner cannot follow is caught rather than skipped.
 */

import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { prepareForScripts, runRepositoryScript } from './bunScripts';
import {
	type JsonRecord,
	parseJsonRecord,
	readJsonRecord,
	recordField,
	stringField,
	stringMap,
} from './jsonFiles';
import { installFromRegistry, type PackedPackage } from './registryInstall';
import { readRepositoryFile } from './repository';

export interface TutorialCommand {
	/** The `## ` heading the command sits under, for failure messages. */
	readonly step: string;
	readonly line: string;
}

/** Every line of every `sh` block, in page order, without trailing comments. */
export function tutorialCommands(markdown: string): readonly TutorialCommand[] {
	const commands: TutorialCommand[] = [];
	let step = '';
	let inShell = false;
	for (const raw of markdown.split('\n')) {
		if (!inShell && raw.startsWith('## ')) step = raw.slice(3).trim();
		if (raw.trim() === '```sh') {
			inShell = true;
			continue;
		}
		if (inShell && raw.trim() === '```') {
			inShell = false;
			continue;
		}
		if (!inShell) continue;
		const line = raw.replace(/\s+#.*$/, '').trim();
		if (line.length > 0) commands.push({ step, line });
	}
	return commands;
}

const GENERATED_PARENTS = ['apps/api/convex/plugins', 'apps/web/app/plugins'];
const WORKSPACE_GLOBS = ['packages/*', 'examples/plugins/*'];
const temporaryBases: string[] = [];

export class TutorialRun {
	private cwd: string;
	private previousCwd: string;
	private readonly registry = new Map<string, PackedPackage>();
	/** What each command printed, for the PR-style transcript a failure shows. */
	readonly transcript: string[] = [];

	private constructor(readonly root: string) {
		this.cwd = root;
		this.previousCwd = root;
	}

	/**
	 * A directory shaped like an Owlat checkout: the root manifest with the real
	 * workspace globs and catalog, a `packages/plugin-kit` member at the real
	 * version, an empty `plugins.config.ts` and lock, and the generated-output
	 * directories. It sits one level down in its own temporary base, so the
	 * tutorial's `mv … ../<folder>` stays inside what the run cleans up.
	 */
	static async start(): Promise<TutorialRun> {
		const base = await mkdtemp(join(tmpdir(), 'owlat-plugin-tutorial-'));
		temporaryBases.push(base);
		const root = join(base, 'owlat');
		const repositoryRoot = parseJsonRecord(
			await readRepositoryFile('package.json'),
			'package.json'
		);
		const catalog = stringMap(
			recordField(repositoryRoot, 'workspaces', 'package.json'),
			'catalog',
			'workspaces'
		);
		const kitLabel = 'packages/plugin-kit/package.json';
		const kit = parseJsonRecord(await readRepositoryFile(kitLabel), kitLabel);
		await writeJson(join(root, 'package.json'), {
			name: 'owlat',
			private: true,
			type: 'module',
			workspaces: { packages: WORKSPACE_GLOBS, catalog },
		});
		await writeJson(join(root, 'packages', 'plugin-kit', 'package.json'), {
			name: stringField(kit, 'name', kitLabel),
			version: stringField(kit, 'version', kitLabel),
		});
		await writeJson(join(root, 'bun.lock'), { workspaces: { '': {} }, packages: {} });
		await writeFile(
			join(root, 'plugins.config.ts'),
			"import type { PluginsConfig } from '@owlat/plugin-codegen';\n\nexport default {\n\tbundledPluginPackages: [],\n} satisfies PluginsConfig;\n"
		);
		for (const parent of GENERATED_PARENTS) await mkdir(join(root, parent), { recursive: true });
		await mkdir(join(root, 'examples', 'plugins'), { recursive: true });
		await prepareForScripts(root);
		return new TutorialRun(root);
	}

	async execute(command: TutorialCommand): Promise<void> {
		this.transcript.push(`$ ${command.line}`);
		try {
			const output = await this.dispatch(command.line.split(/\s+/));
			if (output.length > 0) this.transcript.push(output.trimEnd());
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Step "${command.step}": \`${command.line}\` failed:\n${reason}`, {
				cause: error,
			});
		}
	}

	private async dispatch(words: readonly string[]): Promise<string> {
		const [program, first, ...rest] = words;
		if (program === 'cd') return this.changeDirectory(first ?? '');
		if (program === 'mv') return this.move(first ?? '', rest[0] ?? '');
		if (program === 'npm' && first === 'pkg') return this.editPackageJson(rest);
		if (program !== 'bun') throw new Error('this runner does not know the command');
		if (first === 'publish') return this.publish(rest);
		if (first === 'add') return this.add(rest);
		if (first === 'packages/plugin-cli/src/index.ts') return this.script('cli', rest);
		if (first !== 'run') throw new Error('this runner does not know the command');
		const [script, ...args] = rest;
		if (script === 'plugins:prepare') {
			// The test run already depends on the built kit (turbo's
			// `@owlat/plugin-kit#build`); rebuilding it here would wipe `dist`
			// under every concurrent suite.
			return '(kit contracts already built for this test run)';
		}
		if (script === 'owlat-plugins') return this.script('cli', args);
		if (script === 'plugins:codegen') return this.script('codegen', args);
		if (script === '--cwd') return this.packageScript(args[0] ?? '', args[1] ?? '');
		throw new Error('this runner does not know the command');
	}

	private script(which: 'cli' | 'codegen', args: readonly string[]): string {
		const result = runRepositoryScript(
			this.cwd,
			which === 'cli' ? 'packages/plugin-cli/src/index.ts' : 'packages/plugin-codegen/src/cli.ts',
			args
		);
		const output = result.output.replaceAll(this.root, '<checkout>');
		if (result.status !== 0) throw new Error(`exit ${result.status}\n${output}`);
		return output;
	}

	/**
	 * A package's own test and typecheck scripts need the checkout's toolchain,
	 * which this directory does not have. The scaffold's suites are run as
	 * emitted by `scaffoldedProviderConformance.test.ts`; here the script only
	 * has to exist, so the command the reader types resolves.
	 */
	private async packageScript(directory: string, script: string): Promise<string> {
		const manifest = await readJsonRecord(join(resolve(this.cwd, directory), 'package.json'));
		if (!stringMap(manifest, 'scripts', directory)[script])
			throw new Error(`${directory} has no "${script}" script`);
		return `(not run here: ${directory} defines "${script}")`;
	}

	private changeDirectory(target: string): string {
		const next = target === '-' ? this.previousCwd : resolve(this.cwd, target);
		this.previousCwd = this.cwd;
		this.cwd = next;
		return '';
	}

	private async move(from: string, to: string): Promise<string> {
		await rename(resolve(this.cwd, from), resolve(this.cwd, to));
		return '';
	}

	private async editPackageJson(args: readonly string[]): Promise<string> {
		const [action, ...operands] = args;
		const manifest = await readJsonRecord(join(this.cwd, 'package.json'));
		for (const operand of operands) {
			if (action === 'delete') delete manifest[operand];
			else if (action === 'set') {
				const separator = operand.indexOf('=');
				manifest[operand.slice(0, separator)] = operand.slice(separator + 1);
			} else throw new Error(`npm pkg ${action} is not modelled`);
		}
		await writeJson(join(this.cwd, 'package.json'), manifest);
		return '';
	}

	/** What `bun publish` uploads: the manifest with its ranges resolved, and the files. */
	private async publish(args: readonly string[]): Promise<string> {
		const manifest = await readJsonRecord(join(this.cwd, 'package.json'));
		const name = stringField(manifest, 'name', 'package.json');
		const version = stringField(manifest, 'version', 'package.json');
		if (manifest['private'] === true) {
			throw new Error('error: attempted to publish a private package');
		}
		const access = args[args.indexOf('--access') + 1];
		if (name.startsWith('@') && (!args.includes('--access') || access !== 'public')) {
			throw new Error('a scoped package publishes as restricted unless --access public is passed');
		}
		const key = `${name}@${version}`;
		if (this.registry.has(key)) throw new Error(`${key} is already published`);
		const catalog = await this.catalog();
		const resolved: JsonRecord = { ...manifest };
		for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
			if (manifest[field] === undefined) continue;
			const next: Record<string, string> = {};
			for (const [dependency, range] of Object.entries(stringMap(manifest, field, name))) {
				if (range.startsWith('workspace:')) {
					const member = await this.workspaceMember(dependency);
					if (!member) throw new Error(`no workspace package named ${dependency}`);
					next[dependency] = member.version;
				} else if (range === 'catalog:') {
					const pinned = catalog[dependency];
					if (!pinned) throw new Error(`no catalog entry for ${dependency}`);
					next[dependency] = pinned;
				} else next[dependency] = range;
			}
			resolved[field] = next;
		}
		const files = new Map<string, string>([
			['package.json', `${JSON.stringify(resolved, null, '\t')}\n`],
		]);
		await collectFiles(this.cwd, '', files);
		this.registry.set(key, { name, version, files });
		return `+ ${key}`;
	}

	private async add(args: readonly string[]): Promise<string> {
		const spec = args.find((arg) => !arg.startsWith('--')) ?? '';
		if (!args.includes('--exact')) throw new Error('the tutorial pins with --exact');
		const at = spec.lastIndexOf('@');
		const name = spec.slice(0, at);
		const member = await this.workspaceMember(name);
		if (member) {
			// What Bun does: a workspace folder of the same name wins over the
			// registry, and the lock records a workspace link.
			await this.recordLink(name, member.directory);
			return `installed ${name}@workspace:${member.directory}`;
		}
		const packed = this.registry.get(spec);
		if (!packed) throw new Error(`error: GET ${spec} - 404`);
		await installFromRegistry(this.root, packed);
		return `installed ${spec}`;
	}

	private async recordLink(name: string, directory: string): Promise<void> {
		const target = join(this.root, 'node_modules', ...name.split('/'));
		await mkdir(join(target, '..'), { recursive: true });
		await symlink(join(this.root, directory), target, 'dir');
		const lock = await readJsonRecord(join(this.root, 'bun.lock'));
		recordField(lock, 'packages', 'bun.lock')[name] = [`${name}@workspace:${directory}`];
		await writeJson(join(this.root, 'bun.lock'), lock);
	}

	private async catalog(): Promise<Record<string, string>> {
		const root = await readJsonRecord(join(this.root, 'package.json'));
		return stringMap(recordField(root, 'workspaces', 'package.json'), 'catalog', 'workspaces');
	}

	private async workspaceMember(
		name: string
	): Promise<{ directory: string; version: string } | undefined> {
		for (const glob of WORKSPACE_GLOBS) {
			const parent = glob.slice(0, -2);
			const entries = await readdir(join(this.root, parent), { withFileTypes: true }).catch(
				() => []
			);
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const directory = `${parent}/${entry.name}`;
				const manifest = await readJsonRecord(join(this.root, directory, 'package.json')).catch(
					() => undefined
				);
				if (manifest?.['name'] === name) {
					return { directory, version: stringField(manifest, 'version', directory) };
				}
			}
		}
		return undefined;
	}
}

export async function cleanupTutorialRuns(): Promise<void> {
	await Promise.all(
		temporaryBases.splice(0).map((base) => rm(base, { recursive: true, force: true }))
	);
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, '\t')}\n`);
}

async function collectFiles(
	root: string,
	relativeDirectory: string,
	files: Map<string, string>
): Promise<void> {
	const directory = join(root, relativeDirectory);
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = relative(root, join(directory, entry.name)).split('\\').join('/');
		if (entry.name === 'node_modules' || path === 'package.json') continue;
		if (entry.isDirectory()) await collectFiles(root, path, files);
		else if (entry.isFile()) files.set(path, await readFile(join(root, path), 'utf8'));
	}
}
