/**
 * Remote/local command builders for the desktop "set up a new server" flow:
 * the exact command strings the wizard drives over SSH (probe, install Docker,
 * fetch the repo, run the installer) plus the local docker invocations used by
 * the local-source modes. Split from `provisioning.ts` (timeline + transport),
 * which consumes these via {@link InstallSource}.
 *
 * Everything here is a pure string/spec builder — unit testable without SSH.
 */

export interface RemoteOptions {
	/** Install directory on the server (default /opt/owlat). */
	installDir: string;
	/** Git remote to clone from. */
	repo: string;
	/** Branch to install. */
	branch: string;
	/**
	 * Local-source dev mode: absolute path to the monorepo root on THIS machine.
	 * When set, the working tree is uploaded over SSH instead of git-cloned, and
	 * the Owlat images come from that source (the `dev` tag sentinel from
	 * docker-compose.yml) — no published repo/registry needed.
	 */
	localSource?: string;
	/**
	 * With `localSource`: build the images on THIS machine (targeting the
	 * server's architecture) and stream them over SSH instead of building on
	 * the server — for servers without the RAM/CPU for a Nuxt build.
	 */
	localImages?: boolean;
}

/** How the install source reaches the server (derived from RemoteOptions). */
export type InstallSource = 'git' | 'local-build' | 'local-push';

export function installSource(o: RemoteOptions): InstallSource {
	if (!o.localSource) return 'git';
	return o.localImages ? 'local-push' : 'local-build';
}

export const DEFAULT_REMOTE: RemoteOptions = {
	installDir: '/opt/owlat',
	repo: 'https://github.com/wolvesdotink/owlat.git',
	branch: 'main',
};

/** Host path the generated config is uploaded to (inside the install dir). */
export function setupConfigPath(installDir: string): string {
	return `${installDir}/.owlat-setup.json`;
}

/**
 * Path the config resolves to INSIDE the setup container. `scripts/owlat` always
 * mounts the install dir at `/opt/owlat` (and sets `OWLAT_DIR=/opt/owlat`), so
 * the container sees the uploaded file here regardless of the host install dir.
 */
export const CONTAINER_CONFIG_PATH = '/opt/owlat/.owlat-setup.json';

/** Probe the server: OS, arch, docker presence, compose v2. Output parsed for `docker=no` / `arch=`. */
export function systemCheckCommand(): string {
	return [
		'echo "os=$(uname -s)"',
		'echo "arch=$(uname -m)"',
		'if command -v docker >/dev/null 2>&1; then echo docker=yes; else echo docker=no; fi',
		'if docker compose version >/dev/null 2>&1; then echo compose=yes; else echo compose=no; fi',
	].join('; ');
}

/** Map `uname -m` output to a Docker platform string. */
export function dockerPlatform(unameArch: string): string {
	const a = unameArch.trim();
	if (a === 'aarch64' || a === 'arm64') return 'linux/arm64';
	return 'linux/amd64';
}

/** Install Docker via the official convenience script (idempotent). */
export function installDockerCommand(): string {
	return 'if command -v docker >/dev/null 2>&1; then echo "docker already present"; else curl -fsSL https://get.docker.com | sudo sh; fi';
}

/**
 * Local-source installs build everything on the server under the `dev` tag —
 * docker-compose.yml's documented "local build, never pushed" sentinel — so
 * `image:` interpolation resolves to the locally built images instead of
 * pulling `:latest` from GHCR.
 */
export const LOCAL_VERSION_TAG = 'dev';
export const LOCAL_SETUP_IMAGE = `ghcr.io/wolvesdotink/setup:${LOCAL_VERSION_TAG}`;

/** Create the install dir (root-owned path like /opt) and hand it to the SSH user. */
export function prepareInstallDirCommand(o: RemoteOptions): string {
	return `sudo mkdir -p '${o.installDir}' && sudo chown "$(id -u):$(id -g)" '${o.installDir}'`;
}

/** Clone (or fast-forward) the Owlat repo into the install dir. */
export function fetchOwlatCommand(o: RemoteOptions): string {
	const d = o.installDir;
	return [
		'set -e',
		`if [ -d '${d}/.git' ]; then`,
		`  cd '${d}' && git fetch --depth 1 origin '${o.branch}' && git reset --hard 'origin/${o.branch}'`,
		'else',
		`  ${prepareInstallDirCommand(o)} && git clone --depth 1 --branch '${o.branch}' '${o.repo}' '${d}'`,
		'fi',
	].join('\n');
}

/** Build the setup-cli image from the uploaded source (local-source mode). */
export function buildSetupImageCommand(o: RemoteOptions): string {
	return `cd '${o.installDir}' && docker build -f apps/setup-cli/Dockerfile -t '${LOCAL_SETUP_IMAGE}' .`;
}

/** Every image the stack needs under the `dev` tag (push-images mode). */
export const DEV_IMAGES = [
	`ghcr.io/wolvesdotink/web:${LOCAL_VERSION_TAG}`,
	`ghcr.io/wolvesdotink/mta:${LOCAL_VERSION_TAG}`,
	`ghcr.io/wolvesdotink/updater:${LOCAL_VERSION_TAG}`,
	`ghcr.io/wolvesdotink/convex-deploy:${LOCAL_VERSION_TAG}`,
	`owlat-code-worker:${LOCAL_VERSION_TAG}`,
	LOCAL_SETUP_IMAGE,
] as const;

/**
 * Local `docker compose build` invocation (push-images mode), targeting the
 * server's platform. All profiles so every buildable service is covered;
 * `INSTANCE_SECRET` only silences compose interpolation warnings.
 */
export function localBuildInvocation(platform: string): {
	program: string;
	args: string[];
	env: Record<string, string>;
} {
	return {
		program: 'docker',
		args: [
			'compose',
			'--profile',
			'deploy',
			'--profile',
			'ai',
			'build',
			'web',
			'mta',
			'updater',
			'convex-deploy',
			'code-worker',
		],
		env: {
			OWLAT_VERSION: LOCAL_VERSION_TAG,
			DOCKER_DEFAULT_PLATFORM: platform,
			INSTANCE_SECRET: 'build-only',
		},
	};
}

/** Local build of the setup-cli image (push-images mode). */
export function localSetupImageInvocation(platform: string): {
	program: string;
	args: string[];
	env: Record<string, string>;
} {
	return {
		program: 'docker',
		args: [
			'build',
			'--platform',
			platform,
			'-f',
			'apps/setup-cli/Dockerfile',
			'-t',
			LOCAL_SETUP_IMAGE,
			'.',
		],
		env: {},
	};
}

/**
 * Drive the existing installer non-interactively with machine-readable progress.
 * `scripts/owlat` forwards `OWLAT_PROGRESS` + `--config` into the setup container.
 * Local-source modes pin the `dev` setup image and tell quickstart either to
 * `docker compose --build` from source (`OWLAT_BUILD_LOCAL`) or to use the
 * pre-pushed `dev` images as-is (`OWLAT_LOCAL_IMAGES`).
 */
export function installerCommand(o: RemoteOptions): string {
	const source = installSource(o);
	const localEnv =
		source === 'git'
			? ''
			: `OWLAT_VERSION=${LOCAL_VERSION_TAG} OWLAT_SETUP_IMAGE='${LOCAL_SETUP_IMAGE}' ${
					source === 'local-push' ? 'OWLAT_LOCAL_IMAGES=1' : 'OWLAT_BUILD_LOCAL=1'
				} `;
	return `cd '${o.installDir}' && ${localEnv}OWLAT_PROGRESS=json OWLAT_ASSUME_YES=1 ./scripts/owlat quickstart --terminal --config '${CONTAINER_CONFIG_PATH}'`;
}
