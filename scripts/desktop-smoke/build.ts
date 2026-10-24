/**
 * Builds what the smoke test and the updater run need, into one directory:
 *
 *   <out>/web-server/       apps/web `nuxt build` output (serves the update route)
 *   <out>/keys/             an ephemeral minisign key pair, made for this build
 *   <out>/<version>/        a fixture AppImage and its `.sig`, for N and N+1
 *   <out>/fixtures.json     the two versions and the paths above
 *
 * Both AppImages are debug builds with the `e2e-fixture` feature, the desktop
 * SPA packaged exactly as a release packages it, and the generated public key
 * in place of the production one. N is the version in Cargo.toml and N+1 the
 * next patch, applied through tauri's `--config` (it overrides the Cargo.toml
 * version), so no tracked file is rewritten.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appImageName, nextVersion, packageVersion, repositoryPath } from './release';

export interface Fixtures {
	readonly from: string;
	readonly to: string;
	readonly repoPath: string;
	readonly webServer: string;
	readonly appImages: Readonly<Record<string, string>>;
}

export const FIXTURES_FILE = 'fixtures.json';
const PRODUCT_NAME = 'Owlat';

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
	console.info(`\n$ ${command} ${args.join(' ')}   (in ${cwd})`);
	const result = spawnSync(command, [...args], {
		cwd,
		env: { ...process.env, ...env },
		stdio: 'inherit',
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args[0] ?? ''} failed (${result.signal ?? `exit ${result.status}`})`
		);
	}
}

export function readFixtures(dir: string): Fixtures {
	return JSON.parse(readFileSync(join(dir, FIXTURES_FILE), 'utf8')) as Fixtures;
}

export function buildFixtures(root: string, outArg: string): Fixtures {
	const out = resolve(outArg);
	const web = join(root, 'apps/web');
	const desktop = join(root, 'apps/desktop');
	const tauriDir = join(desktop, 'src-tauri');
	const cargoToml = readFileSync(join(tauriDir, 'Cargo.toml'), 'utf8');
	const from = packageVersion(cargoToml);
	const to = nextVersion(from);
	mkdirSync(out, { recursive: true });

	// Both web builds write apps/web/.output: the server build is moved out of
	// the way before the desktop SPA, which tauri packages from there, is made.
	const webServer = join(out, 'web-server');
	rmSync(webServer, { recursive: true, force: true });
	run('bun', ['run', 'build'], web, { NITRO_PRESET: 'node-server' });
	// Copied, not renamed: the output directory may be on another filesystem.
	// Nitro links package versions with relative symlinks; keep them relative.
	cpSync(join(web, '.output'), webServer, { recursive: true, verbatimSymlinks: true });
	rmSync(join(web, '.output'), { recursive: true, force: true });
	run('bun', ['run', 'generate:desktop'], web);

	const keyPath = join(out, 'keys/updater.key');
	mkdirSync(join(out, 'keys'), { recursive: true });
	run(
		'bun',
		['run', 'tauri', 'signer', 'generate', '--ci', '-f', '-p', '', '-w', keyPath],
		desktop
	);
	const pubkey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
	const signingEnv = {
		TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim(),
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
	};

	const appImages: Record<string, string> = {};
	for (const version of [from, to]) {
		const configPath = join(out, `tauri.${version}.json`);
		writeFileSync(
			configPath,
			JSON.stringify({
				version,
				// The SPA was generated above; null removes the hook from the merge.
				build: { beforeBuildCommand: null },
				bundle: { createUpdaterArtifacts: true },
				plugins: { updater: { pubkey } },
			})
		);
		run(
			'bun',
			[
				'run',
				'tauri',
				'build',
				'--debug',
				'--features',
				'e2e-fixture',
				'--bundles',
				'appimage',
				'--config',
				configPath,
			],
			desktop,
			signingEnv
		);
		const name = appImageName(PRODUCT_NAME, version);
		const built = join(tauriDir, 'target/debug/bundle/appimage', name);
		if (!existsSync(`${built}.sig`))
			throw new Error(`the build left no signature next to ${built}`);
		const dir = join(out, version);
		mkdirSync(dir, { recursive: true });
		cpSync(built, join(dir, name));
		cpSync(`${built}.sig`, join(dir, `${name}.sig`));
		appImages[version] = join(dir, name);
	}

	const fixtures: Fixtures = {
		from,
		to,
		repoPath: repositoryPath(cargoToml),
		webServer,
		appImages,
	};
	writeFileSync(join(out, FIXTURES_FILE), `${JSON.stringify(fixtures, null, '\t')}\n`);
	return fixtures;
}
