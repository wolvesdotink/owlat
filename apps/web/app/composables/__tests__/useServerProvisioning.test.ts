import { describe, it, expect } from 'vitest';
import { PROGRESS_SENTINEL, SetupStep } from '@owlat/shared/setupProgress';
import { useServerProvisioning, type ServerCredentials } from '../useServerProvisioning';
import type { ProvisionTransport, ConnectInfo, ExecEvent, SetupConfigInput } from '~/lib/desktop/provisioning';

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
}

class FakeTransport implements ProvisionTransport {
	commands: string[] = [];
	uploads: Array<{ localDir: string; remoteDir: string }> = [];
	localCommands: Array<{ program: string; args: string[]; cwd: string; env: Record<string, string> }> = [];
	pushedImages: string[][] = [];
	constructor(private opts: FakeOpts = {}) {}

	async connect(host: string, port: number): Promise<ConnectInfo> {
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
		const out = (line: string) => onEvent({ kind: 'stdout', line });
		const err = (line: string) => onEvent({ kind: 'stderr', line });
		if (command.includes('quickstart')) {
			for (const l of this.opts.installerLines ?? []) out(l);
			for (const l of this.opts.installerStderr ?? []) err(l);
			return this.opts.installerExit ?? 0;
		}
		if (command.startsWith('rm -f')) {
			return this.opts.cleanupExit ?? 0;
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
	async writeFile(): Promise<void> {}
	async uploadDir(_id: string, localDir: string, remoteDir: string): Promise<void> {
		if (this.opts.uploadError) throw new Error(this.opts.uploadError);
		this.uploads.push({ localDir, remoteDir });
	}
	async pushImages(_id: string, images: string[]): Promise<void> {
		this.pushedImages.push(images);
	}
	async localExec(
		program: string,
		args: string[],
		cwd: string,
		env: Record<string, string>,
	): Promise<number> {
		this.localCommands.push({ program, args, cwd, env });
		return 0;
	}
	async disconnect(): Promise<void> {}
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
			installerLines: happyInstallerLines({ siteUrl: 'http://1.2.3.4:3000', adminEmail: 'admin@acme.test' }),
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
		expect(t.commands.some((c) => c.includes('OWLAT_PROGRESS=json') && c.includes('quickstart'))).toBe(true);
	});

	it('fails when the installer exits non-zero without a done event', async () => {
		const { p } = await provisioned({
			dockerLine: 'docker=yes',
			installerLines: [sentinel({ v: 1, event: 'step', id: SetupStep.ComposeUp, title: 'x', status: 'failed', ts: 1 })],
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
			installerLines: [sentinel({ v: 1, event: 'step', id: SetupStep.ComposeUp, title: 'x', status: 'failed', ts: 1 })],
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
		expect(fetch?.title).toBe('Upload Owlat (local source)');

		// the setup image is built on the server before the installer runs
		const buildIdx = t.commands.findIndex((c) => c.includes('docker build -f apps/setup-cli/Dockerfile'));
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
		expect(p.steps.find((s) => s.id === 'fetch-owlat')?.title).toBe('Upload Owlat (local source)');
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

		// local builds: stack compose build + the setup image, in the source dir,
		// pinned to the server's platform (fake reports x86_64).
		expect(t.localCommands).toHaveLength(2);
		expect(t.localCommands[0]?.args).toContain('compose');
		expect(t.localCommands[0]?.cwd).toBe('/Users/dev/owlat');
		expect(t.localCommands[0]?.env['DOCKER_DEFAULT_PLATFORM']).toBe('linux/amd64');
		expect(t.localCommands[1]?.args).toContain('apps/setup-cli/Dockerfile');

		// images streamed once, including the setup image.
		expect(t.pushedImages).toHaveLength(1);
		expect(t.pushedImages[0]).toContain('ghcr.io/wolvesdotink/setup:dev');
		expect(t.pushedImages[0]).toContain('ghcr.io/wolvesdotink/web:dev');

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
			installerLines: [sentinel({ v: 1, event: 'step', id: SetupStep.ComposeUp, title: 'x', status: 'failed', ts: 1 })],
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
		expect(t.commands.some((c) => c.startsWith('rm -f') && c.includes('.owlat-setup.json'))).toBe(true);
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
