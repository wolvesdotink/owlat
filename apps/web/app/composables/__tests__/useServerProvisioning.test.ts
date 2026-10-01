import { describe, it, expect, vi } from 'vitest';
import { COMPOSE_BUILD_SERVICES } from '@owlat/shared/composeBuildServices';
import { PROGRESS_SENTINEL, SetupStep } from '@owlat/shared/setupProgress';
import { createTestI18n } from '~/__tests__/i18n';
import { useServerProvisioning, type ServerCredentials } from '../useServerProvisioning';
import {
	DEV_IMAGES,
	type ProvisionTransport,
	type ConnectInfo,
	type ExecEvent,
	type LocalBuild,
	type SetupConfigInput,
} from '~/lib/desktop/provisioning';

// The wizard is driven outside a component here, so `useI18n` is stubbed with
// the real catalog's `t`: the timeline details and failure sentences asserted
// below stay the English an operator reads.
const { t: translate } = createTestI18n().global;
vi.stubGlobal('useI18n', () => ({ t: translate }));

// ---- a scriptable fake of the native SSH transport -------------------------

interface FakeOpts {
	knownHostStatus?: ConnectInfo['knownHostStatus'];
	dockerLine?: 'docker=yes' | 'docker=no';
	installerLines?: string[];
	installerStderr?: string[];
	installerExit?: number;
	cleanupExit?: number;
	authError?: string;
	uploadError?: string;
	// The config upload fails (it may still have created the file).
	writeError?: string;
	// The installer's exec fails in the transport (the session dropped).
	installerError?: string;
	// The installer (or a local build) runs until the session is cancelled,
	// like a hung server that never sends EOF.
	installerHangs?: boolean;
	localBuildHangs?: boolean;
	// Images the post-push check reports as missing on the server.
	missingImages?: string[];
	// stdout emitted by the public-IP probe; undefined = no output (detection fails).
	publicIpLine?: string;
	// stdout emitted by the latest-release lookup; null = no output (lookup fails).
	releaseLine?: string | null;
}

class FakeTransport implements ProvisionTransport {
	commands: string[] = [];
	uploads: Array<{ localDir: string; remoteDir: string }> = [];
	localBuilds: Array<{ sessionId: string; localDir: string; build: LocalBuild }> = [];
	pushedImages: string[][] = [];
	writes: Array<{ path: string; content: string }> = [];
	// Every call that changes the session, in order: what leaving does, and
	// that nothing starts after it.
	journal: string[] = [];
	// Hold connect() until the test releases it (a handshake in flight).
	connectGate: Promise<void> | null = null;
	private cancelled: Array<() => void> = [];
	constructor(private opts: FakeOpts = {}) {}

	/** A call that only ends when the session is cancelled, then rejects like the native side. */
	private untilCancelled<T>(): Promise<T> {
		return new Promise<T>((_resolve, reject) => {
			this.cancelled.push(() => reject(new Error('Cancelled.')));
		});
	}

	async cancel(sessionId: string): Promise<void> {
		this.journal.push(`cancel ${sessionId}`);
		for (const stop of this.cancelled.splice(0)) stop();
	}

	async connect(host: string, port: number): Promise<ConnectInfo> {
		if (this.connectGate) await this.connectGate;
		return {
			sessionId: 's1',
			fingerprint: 'SHA256:deadbeef',
			hostKeyType: 'ssh-ed25519',
			knownHostStatus: this.opts.knownHostStatus ?? 'new',
		};
	}
	async acceptHostKey(): Promise<void> {}
	async authenticate(): Promise<void> {
		if (this.opts.authError) throw new Error(this.opts.authError);
	}
	async execStream(_id: string, command: string, onEvent: (e: ExecEvent) => void): Promise<number> {
		this.commands.push(command);
		this.journal.push(`exec ${command}`);
		const out = (line: string) => onEvent({ kind: 'stdout', line });
		const err = (line: string) => onEvent({ kind: 'stderr', line });
		if (command.includes('quickstart')) {
			if (this.opts.installerHangs) return this.untilCancelled();
			if (this.opts.installerError) throw new Error(this.opts.installerError);
			for (const l of this.opts.installerLines ?? []) out(l);
			for (const l of this.opts.installerStderr ?? []) err(l);
			return this.opts.installerExit ?? 0;
		}
		if (command.includes('api.github.com')) {
			const line = this.opts.releaseLine === undefined ? 'release=0.4.6' : this.opts.releaseLine;
			if (line !== null) out(line);
			return 0;
		}
		if (command.includes('api.ipify.org')) {
			if (this.opts.publicIpLine !== undefined) out(this.opts.publicIpLine);
			return 0;
		}
		if (command.startsWith('rm -f')) {
			return this.opts.cleanupExit ?? 0;
		}
		if (command.includes('docker image inspect')) {
			for (const image of this.opts.missingImages ?? []) out(`missing=${image}`);
			return 0;
		}
		if (command.includes('get.docker.com')) {
			out('installing docker');
			return 0;
		}
		if (command.includes('uname -s')) {
			out('os=Linux');
			out('arch=x86_64');
			out(this.opts.dockerLine ?? 'docker=yes');
			out('compose=yes');
			return 0;
		}
		if (command.includes('git ')) {
			out('fetched repo');
			return 0;
		}
		return 0;
	}
	async writeFile(_id: string, path: string, content: string): Promise<void> {
		this.journal.push(`write ${path}`);
		this.writes.push({ path, content });
		if (this.opts.writeError) throw new Error(this.opts.writeError);
	}
	async uploadDir(_id: string, localDir: string, remoteDir: string): Promise<void> {
		if (this.opts.uploadError) throw new Error(this.opts.uploadError);
		this.uploads.push({ localDir, remoteDir });
	}
	async pushImages(_id: string, images: string[]): Promise<void> {
		this.pushedImages.push(images);
	}
	async localBuild(sessionId: string, localDir: string, build: LocalBuild): Promise<number> {
		this.journal.push(`build ${build.kind}`);
		this.localBuilds.push({ sessionId, localDir, build });
		if (this.opts.localBuildHangs) return this.untilCancelled();
		return 0;
	}
	async disconnect(sessionId: string): Promise<void> {
		this.journal.push(`disconnect ${sessionId}`);
		for (const stop of this.cancelled.splice(0)) stop();
	}
}

const creds: ServerCredentials = {
	host: '1.2.3.4',
	port: 22,
	username: 'root',
	auth: { type: 'password', password: 'hunter2hunter2' },
};

const config: SetupConfigInput = {
	version: 1,
	deploymentMode: 'selfhost',
	features: {},
	sending: { provider: 'mta' },
	admin: { email: 'admin@acme.test', name: 'Admin', password: 'supersecret123' },
};

const sentinel = (obj: object) => `${PROGRESS_SENTINEL}${JSON.stringify(obj)}`;
function happyInstallerLines(summary: Record<string, unknown>): string[] {
	const lines: string[] = ['docker compose: pulling images...']; // a raw log line
	for (const id of Object.values(SetupStep)) {
		lines.push(sentinel({ v: 1, event: 'step', id, title: id, status: 'running', ts: 1 }));
		lines.push(sentinel({ v: 1, event: 'step', id, title: id, status: 'ok', ts: 1 }));
	}
	lines.push(sentinel({ v: 1, event: 'done', ok: true, summary, ts: 1 }));
	return lines;
}

describe('useServerProvisioning — connect + host key', () => {
	it('a new host pauses at the host-key stage', async () => {
		const t = new FakeTransport({ knownHostStatus: 'new' });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		expect(p.stage.value).toBe('hostkey');
		expect(p.steps.find((s) => s.id === 'ssh-connect')?.state).toBe('ok');
		expect(p.steps.find((s) => s.id === 'host-key')?.state).toBe('running');
		expect(p.connectInfo.value?.fingerprint).toBe('SHA256:deadbeef');
	});

	it('a known host skips straight to authentication then configure', async () => {
		const t = new FakeTransport({ knownHostStatus: 'match' });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		expect(p.stage.value).toBe('configure');
		expect(p.steps.find((s) => s.id === 'host-key')?.state).toBe('ok');
		expect(p.steps.find((s) => s.id === 'authenticate')?.state).toBe('ok');
	});

	it('accepting the host key authenticates and advances to configure', async () => {
		const t = new FakeTransport({ knownHostStatus: 'new' });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		await p.acceptHostKey();
		expect(p.stage.value).toBe('configure');
		expect(p.steps.find((s) => s.id === 'authenticate')?.state).toBe('ok');
	});

	it('surfaces an authentication failure as an error', async () => {
		const t = new FakeTransport({ knownHostStatus: 'match', authError: 'bad password' });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		expect(p.stage.value).toBe('error');
		expect(p.error.value).toContain('bad password');
		expect(p.steps.find((s) => s.id === 'authenticate')?.state).toBe('failed');
	});
});

describe('useServerProvisioning — public-IP auto-detect over SSH', () => {
	const hostnameCreds: ServerCredentials = { ...creds, host: 'vps.example.com' };

	it('detects the public IP over the SSH session and exposes it as the A-record target', async () => {
		const t = new FakeTransport({ knownHostStatus: 'match', publicIpLine: '203.0.113.9' });
		const p = useServerProvisioning(t);
		await p.connect(hostnameCreds);
		expect(p.stage.value).toBe('configure');
		expect(t.commands.some((c) => c.includes('api.ipify.org'))).toBe(true);
		expect(p.publicIp.value).toBe('203.0.113.9');
		// serverIp is what buildDnsRecords consumes — it must be the detected IP.
		expect(p.serverIp.value).toBe('203.0.113.9');
	});

	it('is fail-soft: empty probe output leaves the IP blank without failing the flow', async () => {
		const t = new FakeTransport({ knownHostStatus: 'match' }); // publicIpLine undefined
		const p = useServerProvisioning(t);
		await p.connect(hostnameCreds);
		expect(p.stage.value).toBe('configure');
		expect(p.publicIp.value).toBe('');
		expect(p.serverIp.value).toBeNull();
	});
});

describe('useServerProvisioning — provisioning', () => {
	async function provisioned(opts: FakeOpts) {
		const t = new FakeTransport({ knownHostStatus: 'match', ...opts });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		await p.provision(config);
		return { t, p };
	}

	it('drives the full timeline to done from the installer NDJSON', async () => {
		const { p } = await provisioned({
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({
				siteUrl: 'http://1.2.3.4:3000',
				adminEmail: 'admin@acme.test',
			}),
		});
		expect(p.stage.value).toBe('done');
		expect(p.steps.find((s) => s.id === SetupStep.ComposeUp)?.state).toBe('ok');
		expect(p.steps.find((s) => s.id === SetupStep.DeployFunctions)?.state).toBe('ok');
		expect(p.steps.find((s) => s.id === 'finish')?.state).toBe('ok');
		expect(p.summary.value?.siteUrl).toBe('http://1.2.3.4:3000');
		expect(p.siteUrl.value).toBe('http://1.2.3.4:3000');
		// raw (non-sentinel) installer output is captured as a log line
		expect(p.logs.value.some((l) => l.line.includes('pulling images'))).toBe(true);
		expect(p.progress.value).toBe(100);
	});

	it('skips Docker install when Docker is already present', async () => {
		const { p } = await provisioned({
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		expect(p.steps.find((s) => s.id === 'install-docker')?.state).toBe('skipped');
	});

	it('installs Docker when it is missing', async () => {
		const { t, p } = await provisioned({
			dockerLine: 'docker=no',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		expect(p.steps.find((s) => s.id === 'install-docker')?.state).toBe('ok');
		expect(t.commands.some((c) => c.includes('get.docker.com'))).toBe(true);
	});

	it('uploads the config and runs the installer with the right command', async () => {
		const { t } = await provisioned({
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		expect(
			t.commands.some((c) => c.includes('OWLAT_PROGRESS=json') && c.includes('quickstart'))
		).toBe(true);
	});

	it('fails when the installer exits non-zero without a done event', async () => {
		const { p } = await provisioned({
			dockerLine: 'docker=yes',
			installerLines: [
				sentinel({
					v: 1,
					event: 'step',
					id: SetupStep.ComposeUp,
					title: 'x',
					status: 'failed',
					ts: 1,
				}),
			],
			installerExit: 1,
		});
		expect(p.stage.value).toBe('error');
		expect(p.steps.find((s) => s.id === 'finish')?.state).toBe('failed');
	});

	it('does not create the build-setup-image step for a published install', async () => {
		const { p } = await provisioned({
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		expect(p.steps.find((s) => s.id === 'build-setup-image')).toBeUndefined();
	});

	it('retry() resets the timeline back to configure while keeping the live session', async () => {
		const { p } = await provisioned({
			dockerLine: 'docker=yes',
			installerLines: [
				sentinel({
					v: 1,
					event: 'step',
					id: SetupStep.ComposeUp,
					title: 'x',
					status: 'failed',
					ts: 1,
				}),
			],
			installerExit: 1,
		});
		expect(p.stage.value).toBe('error');

		p.retry();
		expect(p.stage.value).toBe('configure');
		expect(p.error.value).toBeNull();
		// connect steps stay done (session kept); server steps are reset to pending
		expect(p.steps.find((s) => s.id === 'authenticate')?.state).toBe('ok');
		expect(p.steps.find((s) => s.id === SetupStep.ComposeUp)?.state).toBe('pending');
	});
});

describe('useServerProvisioning — release install', () => {
	it('by default resolves the latest release, clones its tag and pins the version into the installer', async () => {
		const t = new FakeTransport({
			knownHostStatus: 'match',
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		const p = useServerProvisioning(t);
		await p.connect(creds);
		await p.provision(config);
		expect(p.stage.value).toBe('done');

		const resolve = p.steps.find((s) => s.id === 'resolve-release');
		expect(resolve?.state).toBe('ok');
		expect(resolve?.detail).toBe('v0.4.6');
		expect(t.commands.some((c) => c.includes('api.github.com'))).toBe(true);
		const fetch = t.commands.find((c) => c.includes('git clone'));
		expect(fetch).toContain("--branch 'v0.4.6'");
		expect(fetch).not.toContain("'main'");
		const installer = t.commands.find((c) => c.includes('quickstart'));
		expect(installer).toContain("--owlat-version '0.4.6'");
		expect(installer).toContain("OWLAT_SETUP_IMAGE='ghcr.io/wolvesdotink/setup:0.4.6'");
		expect(t.uploads).toEqual([]);
	});

	it('a pinned version skips the lookup and installs that release', async () => {
		const t = new FakeTransport({
			knownHostStatus: 'match',
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		const p = useServerProvisioning(t);
		await p.connect({ ...creds, remote: { version: '0.4.4' } });
		await p.provision(config);
		expect(p.stage.value).toBe('done');
		expect(t.commands.some((c) => c.includes('api.github.com'))).toBe(false);
		expect(p.steps.find((s) => s.id === 'resolve-release')?.state).toBe('skipped');
		expect(t.commands.find((c) => c.includes('git clone'))).toContain("--branch 'v0.4.4'");
		expect(t.commands.find((c) => c.includes('quickstart'))).toContain("--owlat-version '0.4.4'");
	});

	it('a branch (development) install skips the lookup, clones the branch and leaves the version unpinned', async () => {
		const t = new FakeTransport({
			knownHostStatus: 'match',
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		const p = useServerProvisioning(t);
		await p.connect({ ...creds, remote: { branch: 'main' } });
		await p.provision(config);
		expect(p.stage.value).toBe('done');
		expect(t.commands.some((c) => c.includes('api.github.com'))).toBe(false);
		expect(t.commands.find((c) => c.includes('git clone'))).toContain("--branch 'main'");
		expect(t.commands.find((c) => c.includes('quickstart'))).not.toContain('--owlat-version');
	});

	it('fails instead of falling back to main when no release can be resolved', async () => {
		const t = new FakeTransport({
			knownHostStatus: 'match',
			dockerLine: 'docker=yes',
			releaseLine: null,
		});
		const p = useServerProvisioning(t);
		await p.connect(creds);
		await p.provision(config);
		expect(p.stage.value).toBe('error');
		expect(p.error.value).toBe(translate('shared.useServerProvisioning.releaseNotFound'));
		expect(p.steps.find((s) => s.id === 'resolve-release')?.state).toBe('failed');
		expect(t.commands.some((c) => c.includes('git clone'))).toBe(false);
	});
});

describe('useServerProvisioning — local source mode', () => {
	const localCreds: ServerCredentials = {
		...creds,
		remote: { localSource: '/Users/dev/owlat' },
	};

	async function provisionedLocal(opts: FakeOpts) {
		const t = new FakeTransport({ knownHostStatus: 'match', ...opts });
		const p = useServerProvisioning(t);
		await p.connect(localCreds);
		await p.provision(config);
		return { t, p };
	}

	it('uploads the working tree instead of cloning and builds the setup image', async () => {
		const { t, p } = await provisionedLocal({
			dockerLine: 'docker=yes',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		expect(p.stage.value).toBe('done');

		// upload replaced the git clone
		expect(t.uploads).toEqual([{ localDir: '/Users/dev/owlat', remoteDir: '/opt/owlat' }]);
		expect(t.commands.some((c) => c.includes('git clone'))).toBe(false);
		expect(t.commands.some((c) => c.includes('sudo mkdir -p'))).toBe(true);
		const fetch = p.steps.find((s) => s.id === 'fetch-owlat');
		expect(fetch?.state).toBe('ok');
		expect(fetch?.detail).toBe('uploaded local working tree');
		// The timeline's step titles are message keys (the table is module scope),
		// so the pin resolves one before comparing it to the words on screen.
		expect(translate(fetch?.title ?? '')).toBe('Upload Owlat (local source)');

		// the setup image is built on the server before the installer runs
		const buildIdx = t.commands.findIndex((c) =>
			c.includes('docker build -f apps/setup-cli/Dockerfile')
		);
		const installerIdx = t.commands.findIndex((c) => c.includes('quickstart'));
		expect(buildIdx).toBeGreaterThan(-1);
		expect(buildIdx).toBeLessThan(installerIdx);
		expect(p.steps.find((s) => s.id === 'build-setup-image')?.state).toBe('ok');

		// and the installer carries the local-build overrides
		expect(t.commands[installerIdx]).toContain('OWLAT_BUILD_LOCAL=1');
		expect(t.commands[installerIdx]).toContain('OWLAT_SETUP_IMAGE=');
		expect(p.progress.value).toBe(100);
	});

	it('fails the fetch step when the upload fails', async () => {
		const { p } = await provisionedLocal({
			dockerLine: 'docker=yes',
			uploadError: 'is not the Owlat repository root',
		});
		expect(p.stage.value).toBe('error');
		expect(p.error.value).toContain('not the Owlat repository root');
		expect(p.steps.find((s) => s.id === 'fetch-owlat')?.state).toBe('failed');
	});

	it('retry() keeps the local-mode timeline shape', async () => {
		const { p } = await provisionedLocal({
			dockerLine: 'docker=yes',
			uploadError: 'nope',
		});
		p.retry();
		expect(p.steps.find((s) => s.id === 'build-setup-image')?.state).toBe('pending');
		expect(translate(p.steps.find((s) => s.id === 'fetch-owlat')?.title ?? '')).toBe(
			'Upload Owlat (local source)'
		);
	});
});

describe('useServerProvisioning — local source + push-images mode', () => {
	const pushCreds: ServerCredentials = {
		...creds,
		remote: { localSource: '/Users/dev/owlat', localImages: true },
	};

	it('builds locally for the server arch, pushes images, and skips server builds', async () => {
		const t = new FakeTransport({
			knownHostStatus: 'match',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		const p = useServerProvisioning(t);
		await p.connect(pushCreds);
		await p.provision(config);
		expect(p.stage.value).toBe('done');

		// local builds: the stack, then the setup image, in the source dir,
		// pinned to the server's platform (fake reports x86_64). The wizard names
		// what to build; the desktop owns the docker invocation itself.
		expect(t.localBuilds).toHaveLength(2);
		expect(t.localBuilds[0]).toMatchObject({
			sessionId: 's1',
			localDir: '/Users/dev/owlat',
			build: { kind: 'stack', platform: 'linux/amd64' },
		});
		expect(t.localBuilds[1]).toEqual({
			sessionId: 's1',
			localDir: '/Users/dev/owlat',
			build: { kind: 'setupImage', platform: 'linux/amd64' },
		});

		// images streamed once, including the setup image, then checked on the
		// server before anything else runs there.
		expect(t.pushedImages).toEqual([[...DEV_IMAGES]]);
		expect(t.pushedImages[0]).toContain('ghcr.io/wolvesdotink/setup:dev');
		expect(t.pushedImages[0]).toContain('ghcr.io/wolvesdotink/web:dev');
		const verifyIdx = t.commands.findIndex((c) => c.includes('docker image inspect'));
		expect(verifyIdx).toBeGreaterThan(-1);
		expect(verifyIdx).toBeLessThan(t.commands.findIndex((c) => c.includes('quickstart')));

		// nothing builds on the server; installer uses preloaded images.
		expect(t.commands.some((c) => c.includes('docker build'))).toBe(false);
		const installer = t.commands.find((c) => c.includes('quickstart'))!;
		expect(installer).toContain('OWLAT_LOCAL_IMAGES=1');
		expect(installer).not.toContain('OWLAT_BUILD_LOCAL');

		// timeline used the push-mode steps.
		expect(p.steps.find((s) => s.id === 'build-images-local')?.state).toBe('ok');
		expect(p.steps.find((s) => s.id === 'push-images')?.state).toBe('ok');
		expect(p.steps.find((s) => s.id === 'build-setup-image')).toBeUndefined();
		expect(p.progress.value).toBe(100);
	});
});

describe('useServerProvisioning — log cap, failure tail, secrets cleanup', () => {
	async function run(opts: FakeOpts) {
		const t = new FakeTransport({ knownHostStatus: 'match', dockerLine: 'docker=yes', ...opts });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		await p.provision(config);
		return { t, p };
	}

	it('retains far more than 100 log lines so a long build does not scroll its error away', async () => {
		const noisy = Array.from({ length: 400 }, (_, i) => `build output line ${i}`);
		const { p } = await run({
			installerLines: [...noisy, ...happyInstallerLines({ siteUrl: 'http://x:3000' })],
		});
		expect(p.stage.value).toBe('done');
		// The old cap was 100; all 400 noisy lines (plus the raw happy log line) survive.
		expect(p.logs.value.length).toBeGreaterThan(100);
		expect(p.logs.value.some((l) => l.line === 'build output line 0')).toBe(true);
		expect(p.logs.value.some((l) => l.line === 'build output line 399')).toBe(true);
	});

	it('pins the failing step stderr tail on failure', async () => {
		const { p } = await run({
			installerLines: [
				sentinel({
					v: 1,
					event: 'step',
					id: SetupStep.ComposeUp,
					title: 'x',
					status: 'failed',
					ts: 1,
				}),
			],
			installerStderr: ['compose: pulling', 'fatal: no space left on device'],
			installerExit: 1,
		});
		expect(p.stage.value).toBe('error');
		expect(p.failureTail.value).toContain('fatal: no space left on device');
	});

	it('removes the plaintext setup config after a successful install and reports it', async () => {
		const { t, p } = await run({
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		expect(p.stage.value).toBe('done');
		expect(t.commands.some((c) => c.startsWith('rm -f') && c.includes('.owlat-setup.json'))).toBe(
			true
		);
		expect(p.secretsRemoved.value).toBe(true);
	});

	it('a failed cleanup does not fail the install but is reported as not-removed', async () => {
		const { p } = await run({
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
			cleanupExit: 1,
		});
		expect(p.stage.value).toBe('done');
		expect(p.secretsRemoved.value).toBe(false);
	});
});

// ---- #956: local-push builds and pushes every first-party image -----------

describe('useServerProvisioning — local-push images come from the Compose services', () => {
	const pushCreds: ServerCredentials = {
		...creds,
		remote: { localSource: '/Users/dev/owlat', localImages: true },
	};

	it('builds every buildable service and pushes their images, the MTA resolver included', async () => {
		const t = new FakeTransport({
			knownHostStatus: 'match',
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		const p = useServerProvisioning(t);
		await p.connect(pushCreds);
		await p.provision(config);
		expect(p.stage.value).toBe('done');

		const stack = t.localBuilds[0]?.build;
		expect(stack?.kind === 'stack' && stack.services).toEqual(
			COMPOSE_BUILD_SERVICES.map((s) => s.service)
		);
		const pushed = t.pushedImages[0] ?? [];
		// The services the old hand-written list missed: the MTA's DNS
		// resolver, ClamAV, IMAP, mail-sync and the code-task auxiliaries.
		for (const image of [
			'ghcr.io/wolvesdotink/unbound:dev',
			'ghcr.io/wolvesdotink/clamav:dev',
			'ghcr.io/wolvesdotink/imap:dev',
			'ghcr.io/wolvesdotink/mail-sync:dev',
			'ghcr.io/wolvesdotink/tinyproxy:dev',
			'owlat-convex-fn-proxy:dev',
		]) {
			expect(pushed).toContain(image);
		}
	});

	it('stops before the installer when a pushed image is missing on the server', async () => {
		const t = new FakeTransport({
			knownHostStatus: 'match',
			missingImages: ['ghcr.io/wolvesdotink/unbound:dev'],
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		const p = useServerProvisioning(t);
		await p.connect(pushCreds);
		await p.provision(config);

		expect(p.stage.value).toBe('error');
		expect(p.error.value).toBe(
			'These images did not arrive on the server: ghcr.io/wolvesdotink/unbound:dev'
		);
		expect(p.steps.find((s) => s.id === 'push-images')?.state).toBe('failed');
		// Neither the secrets nor the installer reached the server.
		expect(t.writes).toEqual([]);
		expect(t.commands.some((c) => c.includes('quickstart'))).toBe(false);
	});
});

// ---- #953: the uploaded setup config never outlives the install -----------

describe('useServerProvisioning — setup config cleanup on every outcome', () => {
	const CLEANUP = "rm -f '/opt/owlat/.owlat-setup.json'";
	const failedInstaller = [
		sentinel({ v: 1, event: 'step', id: SetupStep.ComposeUp, title: 'x', status: 'failed', ts: 1 }),
	];

	async function run(opts: FakeOpts) {
		const t = new FakeTransport({ knownHostStatus: 'match', dockerLine: 'docker=yes', ...opts });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		await p.provision(config);
		return { t, p };
	}

	it('removes the config after an installer that exits non-zero, keeping its error', async () => {
		const { t, p } = await run({ installerLines: failedInstaller, installerExit: 1 });
		expect(p.stage.value).toBe('error');
		expect(p.error.value).toBe('Provisioning did not complete (exit 1).');
		expect(t.commands.at(-1)).toBe(CLEANUP);
		expect(p.leftoverConfigCleanup.value).toBeNull();
	});

	it('removes the config when the transport fails after the upload', async () => {
		const { t, p } = await run({ installerError: 'channel closed' });
		expect(p.stage.value).toBe('error');
		expect(p.error.value).toBe('channel closed');
		expect(t.commands.at(-1)).toBe(CLEANUP);
	});

	it('treats a failed upload as one that may have left the file behind', async () => {
		const { t, p } = await run({ writeError: 'Remote write failed (exit 1).' });
		expect(p.stage.value).toBe('error');
		expect(p.error.value).toBe('Remote write failed (exit 1).');
		expect(t.commands.some((c) => c.includes('quickstart'))).toBe(false);
		expect(t.commands.at(-1)).toBe(CLEANUP);
	});

	it('does not touch the server for a failure before anything was uploaded', async () => {
		const { t, p } = await run({ releaseLine: null });
		expect(p.stage.value).toBe('error');
		expect(t.writes).toEqual([]);
		expect(t.commands.some((c) => c.startsWith('rm -f'))).toBe(false);
	});

	it('a failed cleanup adds a visible warning without replacing the installer error or leaking secrets', async () => {
		const { p } = await run({ installerLines: failedInstaller, installerExit: 1, cleanupExit: 1 });
		expect(p.stage.value).toBe('error');
		expect(p.error.value).toBe('Provisioning did not complete (exit 1).');
		expect(p.leftoverConfigCleanup.value).toBe(CLEANUP);
		const shown = [
			p.error.value,
			p.leftoverConfigCleanup.value,
			...p.logs.value.map((l) => l.line),
		];
		expect(shown.join('\n')).not.toContain(config.admin!.password);
	});

	it('a retry uploads a fresh config instead of relying on the old one', async () => {
		const { t, p } = await run({
			installerLines: failedInstaller,
			installerExit: 1,
			cleanupExit: 1,
		});
		p.retry();
		expect(p.leftoverConfigCleanup.value).toBeNull();
		await p.provision(config);
		expect(t.writes).toHaveLength(2);
		expect(t.writes[1]).toEqual(t.writes[0]);
		expect(JSON.parse(t.writes[1]!.content)).toEqual(config);
	});

	it('leaving the wizard after a failed cleanup tries the removal again before disconnecting', async () => {
		const { t, p } = await run({
			installerLines: failedInstaller,
			installerExit: 1,
			cleanupExit: 1,
		});
		t.journal.length = 0;
		await p.disconnect();
		// Nothing was running, so nothing is cancelled.
		expect(t.journal).toEqual([`exec ${CLEANUP}`, 'disconnect s1']);
	});

	it('leaving after a successful install only disconnects', async () => {
		const { t, p } = await run({
			installerLines: happyInstallerLines({ siteUrl: 'http://x:3000' }),
		});
		expect(p.secretsRemoved.value).toBe(true);
		t.journal.length = 0;
		await p.disconnect();
		expect(t.journal).toEqual(['disconnect s1']);
	});
});

// ---- #952: leaving the wizard stops what is running ------------------------

/** Let pending promise continuations run (the fake transport resolves at once). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useServerProvisioning — leaving the wizard mid-flight', () => {
	it('cancels a long installer, removes the config, disconnects, and starts nothing after', async () => {
		const t = new FakeTransport({ knownHostStatus: 'match', installerHangs: true });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		const running = p.provision(config);
		while (!t.commands.some((c) => c.includes('quickstart'))) await settle();
		t.journal.length = 0;

		await p.disconnect();
		await running;

		expect(t.journal).toEqual([
			'cancel s1',
			"exec rm -f '/opt/owlat/.owlat-setup.json'",
			'disconnect s1',
		]);
		// Left, not failed: there is no one to show an error to.
		expect(p.stage.value).toBe('provisioning');
		expect(p.error.value).toBeNull();
		expect(p.busy.value).toBe(false);
	});

	it('a step that completes after leaving does not start the next one', async () => {
		let release!: () => void;
		let installing!: () => void;
		const installStarted = new Promise<void>((resolve) => (installing = resolve));
		const t = new FakeTransport({ knownHostStatus: 'match', dockerLine: 'docker=no' });
		const gate = new Promise<void>((resolve) => (release = resolve));
		const exec = t.execStream.bind(t);
		t.execStream = async (id, command, onEvent) => {
			if (command.includes('get.docker.com')) {
				installing();
				await gate; // finishes on its own, whatever the cancel says
			}
			return exec(id, command, onEvent);
		};
		const p = useServerProvisioning(t);
		await p.connect(creds);
		const running = p.provision(config);
		await installStarted;

		const leaving = p.disconnect();
		release();
		await Promise.all([leaving, running]);

		// install-docker finished late; neither the release lookup, the clone,
		// the upload nor the installer ran after it.
		const after = t.commands.slice(t.commands.findIndex((c) => c.includes('get.docker.com')) + 1);
		expect(after).toEqual([]);
		expect(t.writes).toEqual([]);
		expect(t.journal).toContain('disconnect s1');
		expect(p.error.value).toBeNull();
	});

	it('a connect that lands after leaving disconnects its own session and goes no further', async () => {
		let release!: () => void;
		const t = new FakeTransport({ knownHostStatus: 'match' });
		t.connectGate = new Promise<void>((resolve) => (release = resolve));
		const p = useServerProvisioning(t);
		const connecting = p.connect(creds);

		await p.disconnect(); // no session yet: nothing to release here
		expect(t.journal).toEqual([]);
		release();
		await connecting;

		expect(t.journal).toEqual(['disconnect s1']);
		expect(p.connectInfo.value).toBeNull();
		expect(p.stage.value).toBe('connecting');
		expect(p.steps.find((s) => s.id === 'authenticate')?.state).toBe('pending');
	});

	it('cancels a local image build that is still running and pushes nothing', async () => {
		const t = new FakeTransport({ knownHostStatus: 'match', localBuildHangs: true });
		const p = useServerProvisioning(t);
		await p.connect({ ...creds, remote: { localSource: '/Users/dev/owlat', localImages: true } });
		const running = p.provision(config);
		while (!t.localBuilds.length) await settle();

		await p.disconnect();
		await running;

		expect(t.journal.slice(-2)).toEqual(['cancel s1', 'disconnect s1']);
		expect(t.localBuilds).toHaveLength(1);
		expect(t.pushedImages).toEqual([]);
		expect(p.error.value).toBeNull();
	});

	it('leaving an idle wizard only disconnects', async () => {
		const t = new FakeTransport({ knownHostStatus: 'match' });
		const p = useServerProvisioning(t);
		await p.connect(creds);
		t.journal.length = 0;
		await p.disconnect();
		await p.disconnect(); // unmount twice: still one disconnect
		expect(t.journal).toEqual(['disconnect s1']);
	});
});
