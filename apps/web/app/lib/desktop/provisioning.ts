/**
 * Server provisioning core (desktop "set up a new server" flow).
 *
 * Pure, framework-free building blocks the wizard composable orchestrates:
 *  - the canonical, ordered timeline (desktop SSH steps + the server-side steps
 *    that arrive as `@@OWLAT_PROGRESS@@` NDJSON from the installer);
 *  - the remote command strings driven over SSH;
 *  - `applyStepEvent`, which folds a parsed progress event into the timeline.
 *
 * Keeping this here (no Vue, no Tauri) means the whole orchestration is unit
 * testable with a fake transport and scripted events — the SSH path itself can
 * only be exercised against a real server.
 */
import { SetupStep, type ProgressStepEvent } from '@owlat/shared/setupProgress';

// ---- transport (implemented by the native bridge, faked in tests) ----------

export interface ConnectInfo {
	sessionId: string;
	fingerprint: string;
	hostKeyType: string;
	knownHostStatus: 'new' | 'match' | 'mismatch';
}

export type SshAuth =
	| { type: 'password'; password: string }
	/** Pasted key material OR a path to a key file on this machine (`~` expanded natively). */
	| { type: 'key'; privateKey?: string; privateKeyPath?: string; passphrase?: string };

export type ExecEvent =
	| { kind: 'stdout'; line: string }
	| { kind: 'stderr'; line: string }
	| { kind: 'exit'; code: number };

export interface ProvisionTransport {
	connect(host: string, port: number): Promise<ConnectInfo>;
	/** `acceptChanged` must be true to (re)accept a host key that has CHANGED (MITM guard). */
	acceptHostKey(sessionId: string, acceptChanged?: boolean): Promise<void>;
	authenticate(sessionId: string, username: string, auth: SshAuth): Promise<void>;
	execStream(sessionId: string, command: string, onEvent: (e: ExecEvent) => void): Promise<number>;
	writeFile(sessionId: string, path: string, content: string, mode?: string): Promise<void>;
	uploadDir(sessionId: string, localDir: string, remoteDir: string): Promise<void>;
	/** Stream locally built images to the server (docker save → load). */
	pushImages(sessionId: string, images: string[], onEvent: (e: ExecEvent) => void): Promise<void>;
	/** Run a process on THIS machine (local image builds), streaming output. */
	localExec(
		program: string,
		args: string[],
		cwd: string,
		env: Record<string, string>,
		onEvent: (e: ExecEvent) => void,
	): Promise<number>;
	disconnect(sessionId: string): Promise<void>;
}

/** Lazily wraps the desktop SSH bridge so this module stays importable on web/tests. */
export async function createTauriTransport(): Promise<ProvisionTransport> {
	const ssh = await import('@owlat/desktop/src/ssh');
	return {
		connect: (host, port) => ssh.sshConnect(host, port),
		acceptHostKey: (id, acceptChanged) => ssh.sshAcceptHostKey(id, acceptChanged),
		authenticate: (id, user, auth) => ssh.sshAuthenticate(id, user, auth),
		execStream: (id, cmd, on) => ssh.sshExecStream(id, cmd, on),
		writeFile: (id, path, content, mode) => ssh.sshWriteFile(id, path, content, mode),
		uploadDir: (id, localDir, remoteDir) => ssh.sshUploadDir(id, localDir, remoteDir),
		pushImages: (id, images, on) => ssh.sshPushImages(id, images, on),
		localExec: (program, args, cwd, env, on) => ssh.localExecStream(program, args, cwd, env, on),
		disconnect: (id) => ssh.sshDisconnect(id),
	};
}

// ---- the setup config the wizard produces (consumed by setup-cli) ----------
// Mirrors apps/setup-cli/src/lib/setupConfig.ts `SetupConfig`; the server
// validates it with `parseSetupConfig`, which is the source of truth.

export type DeploymentMode = 'selfhost' | 'dev' | 'hosted';

export interface SetupConfigInput {
	version: 1;
	deploymentMode: DeploymentMode;
	features: { flags?: Record<string, boolean>; packs?: Record<string, boolean> };
	sending?:
		| { provider: 'mta' }
		| { provider: 'resend'; apiKey: string }
		| { provider: 'ses'; region: string; accessKeyId: string; secretAccessKey: string };
	ai?:
		| { provider: 'openrouter'; apiKey: string }
		| { provider: 'openai'; apiKey: string }
		| { provider: 'ollama' }
		| { provider: 'custom'; baseUrl: string; apiKey: string; modelFast: string; modelCapable: string };
	integrations?: { googleSafeBrowsingKey?: string; posthog?: { host: string; apiKey: string } };
	admin: { email: string; name: string; password: string };
	domain?: { ehloHostname: string; bounceDomain: string };
	network?: { siteUrl: string; convexUrl: string; convexSiteUrl: string };
	seedDemo?: boolean;
}

/**
 * The subdomain prefixes a single apex domain expands into. One source of
 * truth for the wizard, the DNS instructions, and `Caddyfile.example`'s
 * convention. `convexSite` is `rest.api` (two labels) — the only multi-label
 * prefix.
 */
export const SUBDOMAINS = {
	site: 'owlat',
	convex: 'api',
	convexSite: 'rest.api',
	mail: 'mail',
	bounce: 'bounce',
} as const;

export interface InstanceHostnames {
	/** The app (Nuxt). */
	site: string;
	/** Convex sync backend (WebSocket + HTTP). */
	convex: string;
	/** Convex HTTP actions (auth, webhooks, tracking). */
	convexSite: string;
	/** MTA EHLO hostname (outbound SMTP identity). */
	mail: string;
	/** Bounce / Return-Path domain. */
	bounce: string;
}

/** Strip scheme/trailing slashes from a user-typed apex domain. */
export function normalizeDomain(input: string): string {
	return input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Expand an apex domain (`wolves.ink`) into every owlat hostname. */
export function deriveHostnames(domain: string): InstanceHostnames {
	const d = normalizeDomain(domain);
	return {
		site: `${SUBDOMAINS.site}.${d}`,
		convex: `${SUBDOMAINS.convex}.${d}`,
		convexSite: `${SUBDOMAINS.convexSite}.${d}`,
		mail: `${SUBDOMAINS.mail}.${d}`,
		bounce: `${SUBDOMAINS.bounce}.${d}`,
	};
}

/** Public HTTPS URLs from explicit hostnames (which may be user-overridden). */
export function networkUrlsFromHosts(
	h: Pick<InstanceHostnames, 'site' | 'convex' | 'convexSite'>,
): { siteUrl: string; convexUrl: string; convexSiteUrl: string } {
	return {
		siteUrl: `https://${h.site}`,
		convexUrl: `https://${h.convex}`,
		convexSiteUrl: `https://${h.convexSite}`,
	};
}

/**
 * Public URLs for a domain-based install, following the `Caddyfile.example`
 * convention (`owlat.` / `api.` / `rest.api.` subdomains served behind the
 * `tls` profile). The operator must point those DNS records at the server and
 * open 80/443 for TLS to be issued.
 */
export function deriveNetworkUrls(domain: string): { siteUrl: string; convexUrl: string; convexSiteUrl: string } {
	return networkUrlsFromHosts(deriveHostnames(domain));
}

// ---- reachability + host-key guards (UX traps) -----------------------------

/**
 * Loopback hostnames a desktop app can never reach on a *remote* server: the
 * app's `localhost` is the user's own machine, not the box we provisioned. Used
 * to keep the wizard from baking — or trying to open — an unreachable URL.
 */
export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
	if (!h) return false;
	if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
	return h.startsWith('127.');
}

/** Whether a full URL (or bare host) points at a loopback address. */
export function isLoopbackUrl(url: string | null | undefined): boolean {
	const raw = (url ?? '').trim();
	if (!raw) return false;
	try {
		return isLoopbackHost(new URL(raw).hostname);
	} catch {
		return isLoopbackHost(raw);
	}
}

/**
 * Whether the freshly-provisioned instance may be opened as a workspace from the
 * desktop. It must have a public (non-loopback) URL that the app has actually
 * confirmed reachable (DNS resolved + TLS issued). Guards the "success before
 * usable" trap, where the installer finishes before the public URL works.
 */
export function canOpenWorkspaceUrl(siteUrl: string | null | undefined, reachable: boolean): boolean {
	if (!siteUrl) return false;
	if (isLoopbackUrl(siteUrl)) return false;
	return reachable;
}

export interface HostKeyPrompt {
	status: ConnectInfo['knownHostStatus'];
	/** A *changed* key (already trusted, now different) is the MITM case; a brand-new key is plain TOFU. */
	isMismatch: boolean;
	/** A changed key demands an explicit extra confirmation beyond the single accept click. */
	requiresExplicitConfirmation: boolean;
	tone: 'warn' | 'danger';
	title: string;
	body: string;
}

/**
 * Describe the host-key prompt so the UI (and tests) treat a brand-new key
 * (trust-on-first-use) differently from a key that has CHANGED since last time
 * (possible interception) — the latter must never be a same-click accept.
 */
export function describeHostKey(status: ConnectInfo['knownHostStatus']): HostKeyPrompt {
	if (status === 'mismatch') {
		return {
			status,
			isMismatch: true,
			requiresExplicitConfirmation: true,
			tone: 'danger',
			title: 'Host key has CHANGED',
			body:
				'This server is presenting a different key than the one you trusted before. That can mean the ' +
				'server was rebuilt — or that someone is intercepting the connection. Only continue if you ' +
				'know why the key changed.',
		};
	}
	return {
		status,
		isMismatch: false,
		requiresExplicitConfirmation: false,
		tone: 'warn',
		title: 'Verify the host key',
		body: "First time connecting — confirm this matches your server's fingerprint.",
	};
}

// ---- the timeline ----------------------------------------------------------

export type StepState = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped';
export type StepGroup = 'connect' | 'server' | 'finish';

export interface TimelineStep {
	id: string;
	title: string;
	group: StepGroup;
	state: StepState;
	detail?: string;
}

interface TimelineSpec {
	id: string;
	title: string;
	group: StepGroup;
}

/**
 * The full ordered roadmap, shown up-front so the user can see what's done,
 * what's running, and what's still to come. The `server` ids match
 * `SetupStep` so the installer's NDJSON drives them directly.
 */
export const PROVISION_TIMELINE: readonly TimelineSpec[] = [
	{ id: 'ssh-connect', title: 'Connect over SSH', group: 'connect' },
	{ id: 'host-key', title: 'Verify host key', group: 'connect' },
	{ id: 'authenticate', title: 'Authenticate', group: 'connect' },
	{ id: 'system-check', title: 'Check the server', group: 'connect' },
	{ id: 'install-docker', title: 'Install Docker', group: 'connect' },
	{ id: 'fetch-owlat', title: 'Fetch Owlat', group: 'connect' },
	{ id: 'upload-config', title: 'Upload configuration', group: 'connect' },
	{ id: SetupStep.Preflight, title: 'Check prerequisites', group: 'server' },
	{ id: SetupStep.Config, title: 'Apply configuration', group: 'server' },
	{ id: SetupStep.ComposeUp, title: 'Start containers', group: 'server' },
	{ id: SetupStep.WaitConvex, title: 'Wait for the backend', group: 'server' },
	{ id: SetupStep.AdminKey, title: 'Mint the admin key', group: 'server' },
	{ id: SetupStep.DeployFunctions, title: 'Deploy backend functions', group: 'server' },
	{ id: SetupStep.EnvSet, title: 'Configure the runtime', group: 'server' },
	{ id: SetupStep.WaitRoutes, title: 'Wait for HTTP routes', group: 'server' },
	{ id: SetupStep.BootstrapAdmin, title: 'Create the admin account', group: 'server' },
	{ id: SetupStep.SeedDemo, title: 'Seed demo data', group: 'server' },
	{ id: 'finish', title: 'Finish up', group: 'finish' },
] as const;

/**
 * A fresh timeline (all steps pending). In the local-source modes
 * `fetch-owlat` becomes an upload, and image steps appear before the config
 * upload: built on the server (`local-build`) or built here and streamed over
 * SSH (`local-push`).
 */
export function createTimeline(source: InstallSource = 'git'): TimelineStep[] {
	const steps = PROVISION_TIMELINE.map((s) => ({ ...s, state: 'pending' as StepState }));
	if (source === 'git') return steps;
	const fetch = steps.find((s) => s.id === 'fetch-owlat');
	if (fetch) fetch.title = 'Upload Owlat (local source)';
	const at = steps.findIndex((s) => s.id === 'upload-config');
	const inserted: TimelineStep[] =
		source === 'local-push'
			? [
					{ id: 'build-images-local', title: 'Build images on this machine', group: 'connect', state: 'pending' },
					{ id: 'push-images', title: 'Upload images to the server', group: 'connect', state: 'pending' },
				]
			: [{ id: 'build-setup-image', title: 'Build the setup image', group: 'connect', state: 'pending' }];
	steps.splice(at, 0, ...inserted);
	return steps;
}

const STATE_BY_STATUS: Record<ProgressStepEvent['status'], StepState> = {
	running: 'running',
	ok: 'ok',
	failed: 'failed',
	skipped: 'skipped',
};

/** Fold a parsed server `step` event into the timeline (mutates the matching step). */
export function applyStepEvent(steps: TimelineStep[], ev: ProgressStepEvent): void {
	const step = steps.find((s) => s.id === ev.id);
	if (!step) return;
	step.state = ev.status === 'ok' && ev.warn ? 'warn' : STATE_BY_STATUS[ev.status];
	if (ev.detail) step.detail = ev.detail;
}

/** Mark a desktop-driven (non-NDJSON) step. */
export function setStepState(steps: TimelineStep[], id: string, state: StepState, detail?: string): void {
	const step = steps.find((s) => s.id === id);
	if (!step) return;
	step.state = state;
	if (detail !== undefined) step.detail = detail;
}

// ---- remote commands -------------------------------------------------------

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
		`  ${prepareInstallDirCommand(o)}`,
		`  && git clone --depth 1 --branch '${o.branch}' '${o.repo}' '${d}'`,
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
		args: ['compose', '--profile', 'deploy', '--profile', 'ai', 'build', 'web', 'mta', 'updater', 'convex-deploy', 'code-worker'],
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
		args: ['build', '--platform', platform, '-f', 'apps/setup-cli/Dockerfile', '-t', LOCAL_SETUP_IMAGE, '.'],
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
