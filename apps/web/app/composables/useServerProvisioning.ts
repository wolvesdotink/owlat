/**
 * Drives the desktop "set up a new server" wizard: SSH connect → host-key
 * confirm → authenticate → run the installer, streaming progress into an
 * animated timeline, then hand off to the workspace connector.
 *
 * All side effects go through an injected {@link ProvisionTransport} (the native
 * SSH bridge in the app, a fake in tests), so the whole state machine — including
 * parsing the installer's NDJSON into timeline steps — is unit testable without
 * Tauri or a real server.
 */
import { parseProgressLine } from '@owlat/shared/setupProgress';
import {
	applyStepEvent,
	setStepState,
	createTimeline,
	createTauriTransport,
	systemCheckCommand,
	dockerPlatform,
	installDockerCommand,
	fetchOwlatCommand,
	prepareInstallDirCommand,
	buildSetupImageCommand,
	localBuildInvocation,
	localSetupImageInvocation,
	installerCommand,
	installSource,
	setupConfigPath,
	canOpenWorkspaceUrl,
	isLoopbackUrl,
	detectPublicIpCommand,
	DEFAULT_REMOTE,
	DEV_IMAGES,
	type ProvisionTransport,
	type ConnectInfo,
	type ExecEvent,
	type SshAuth,
	type RemoteOptions,
	type SetupConfigInput,
	type TimelineStep,
} from '~/lib/desktop/provisioning';
import { removeSetupConfigCommand, stderrTail, parsePublicIp, resolveServerIp } from '~/lib/desktop/provisioningForm';

export type ProvisionStage =
	| 'idle'
	| 'connecting'
	| 'hostkey'
	| 'authenticating'
	| 'configure'
	| 'provisioning'
	| 'done'
	| 'error';

export interface ServerCredentials {
	host: string;
	port: number;
	username: string;
	auth: SshAuth;
	remote?: Partial<RemoteOptions>;
}

export interface LogLine {
	stream: 'stdout' | 'stderr';
	line: string;
}

// A whole quickstart run streams thousands of build/log lines; a tight cap used
// to scroll a long failing build's root-cause error out of view before the user
// could read it. Keep a generous scrollback so the failing tail survives.
const MAX_LOG_LINES = 5000;
// How many trailing stderr lines to pin separately on failure (the root cause
// is almost always in the last of these).
const FAILURE_TAIL_LINES = 40;

export function useServerProvisioning(injectedTransport?: ProvisionTransport) {
	const stage = ref<ProvisionStage>('idle');
	const steps = reactive<TimelineStep[]>(createTimeline());
	const logs = ref<LogLine[]>([]);
	const connectInfo = ref<ConnectInfo | null>(null);
	const summary = ref<Record<string, unknown> | null>(null);
	const error = ref<string | null>(null);
	const busy = ref(false);
	// The trailing stderr lines from the step that failed, pinned so the root
	// cause stays readable even after later output scrolls past the cap.
	const failureTail = ref<string[]>([]);
	// Whether the uploaded setup config (admin password + provider keys, in
	// plaintext) was removed from the server after a successful install.
	const secretsRemoved = ref(false);
	// Whether the provisioned site URL has been confirmed reachable from this
	// machine (DNS resolved + TLS issued). Gates the "open workspace" success.
	const siteReachable = ref(false);
	// The server's public IP, auto-detected over the SSH session once
	// authenticated. Only meaningful when the operator connected by hostname
	// (an IP SSH address is already the answer); empty when detection failed,
	// in which case the DNS table falls back to its manual-paste placeholder.
	const publicIp = ref('');

	let transport: ProvisionTransport | null = injectedTransport ?? null;
	let creds: ServerCredentials | null = null;
	let remote: RemoteOptions = { ...DEFAULT_REMOTE };
	let dockerPresent = false;

	async function getTransport(): Promise<ProvisionTransport> {
		if (!transport) transport = await createTauriTransport();
		return transport;
	}

	function pushLog(stream: 'stdout' | 'stderr', line: string): void {
		logs.value.push({ stream, line });
		if (logs.value.length > MAX_LOG_LINES) logs.value.splice(0, logs.value.length - MAX_LOG_LINES);
	}

	function fail(message: string): void {
		error.value = message;
		stage.value = 'error';
		// Pin the failing step's stderr tail so the root cause survives the log cap.
		failureTail.value = stderrTail(logs.value, FAILURE_TAIL_LINES);
		// Mark whatever was running as failed so the timeline reflects the stop point.
		for (const s of steps) if (s.state === 'running') s.state = 'failed';
	}

	/** Step 1: TCP + handshake (no credentials). Surfaces the host-key fingerprint. */
	async function connect(input: ServerCredentials): Promise<void> {
		if (busy.value) return;
		busy.value = true;
		error.value = null;
		failureTail.value = [];
		secretsRemoved.value = false;
		siteReachable.value = false;
		creds = input;
		remote = { ...DEFAULT_REMOTE, ...input.remote };
		stage.value = 'connecting';
		// The timeline shape depends on the install source (the local modes add
		// build/push steps), which is only known now.
		steps.splice(0, steps.length, ...createTimeline(installSource(remote)));
		setStepState(steps, 'ssh-connect', 'running');
		try {
			const t = await getTransport();
			const info = await t.connect(input.host, input.port);
			connectInfo.value = info;
			setStepState(steps, 'ssh-connect', 'ok', `${input.host}:${input.port}`);

			if (info.knownHostStatus === 'match') {
				// Already trusted — skip the prompt and authenticate straight away.
				setStepState(steps, 'host-key', 'ok', 'known host');
				await authenticate();
			} else {
				stage.value = 'hostkey';
				setStepState(steps, 'host-key', 'running', info.fingerprint);
			}
		} catch (e) {
			fail(messageOf(e));
		} finally {
			busy.value = false;
		}
	}

	/**
	 * Step 2: the user accepted the fingerprint — persist it, then authenticate.
	 * `acceptChanged` must be true to (re)accept a host key that has CHANGED since
	 * a previous connection (the possible-MITM case), beyond a single click.
	 */
	async function acceptHostKey(acceptChanged = false): Promise<void> {
		if (busy.value || !connectInfo.value) return;
		busy.value = true;
		try {
			const t = await getTransport();
			await t.acceptHostKey(connectInfo.value.sessionId, acceptChanged);
			setStepState(steps, 'host-key', 'ok', 'accepted');
			await authenticate();
		} catch (e) {
			fail(messageOf(e));
		} finally {
			busy.value = false;
		}
	}

	/** Step 3: send credentials over the (now trusted) session. */
	async function authenticate(): Promise<void> {
		if (!connectInfo.value || !creds) return;
		stage.value = 'authenticating';
		setStepState(steps, 'authenticate', 'running');
		try {
			const t = await getTransport();
			await t.authenticate(connectInfo.value.sessionId, creds.username, creds.auth);
			setStepState(steps, 'authenticate', 'ok', creds.username);
			stage.value = 'configure';
			// Best-effort: pre-fill the DNS A-record target so the operator does
			// not have to paste it manually (only matters when they connected by
			// hostname). Never blocks reaching the configure stage.
			await detectPublicIp(connectInfo.value.sessionId);
		} catch (e) {
			fail(messageOf(e));
		}
	}

	/**
	 * Read the server's public IP over the live SSH session and, if it parses to
	 * a valid address, stash it for the DNS record table. Fail-soft: any transport
	 * error or unparseable output leaves {@link publicIp} empty and the wizard
	 * falls back to the manual-paste placeholder — it must never fail the flow.
	 */
	async function detectPublicIp(sessionId: string): Promise<void> {
		try {
			const t = await getTransport();
			let out = '';
			await t.execStream(sessionId, detectPublicIpCommand(), (e: ExecEvent) => {
				if (e.kind === 'stdout') out += `${e.line}\n`;
			});
			const ip = parsePublicIp(out);
			if (ip) publicIp.value = ip;
		} catch {
			// best-effort — leave publicIp empty on any failure
		}
	}

	/** Run one exec step, streaming output to the log; returns the exit code. */
	async function runExecStep(
		sessionId: string,
		stepId: string,
		command: string,
		onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
	): Promise<number> {
		setStepState(steps, stepId, 'running');
		const t = await getTransport();
		const code = await t.execStream(sessionId, command, (e: ExecEvent) => {
			if (e.kind === 'exit') return;
			pushLog(e.kind, e.line);
			onLine?.(e.line, e.kind);
		});
		if (code !== 0) {
			setStepState(steps, stepId, 'failed', `exit ${code}`);
			throw new Error(`"${stepId}" failed (exit ${code}).`);
		}
		setStepState(steps, stepId, 'ok');
		return code;
	}

	/** Step 4: run the whole installer, streaming progress into the timeline. */
	async function provision(config: SetupConfigInput): Promise<void> {
		if (busy.value || !connectInfo.value) return;
		const sessionId = connectInfo.value.sessionId;
		busy.value = true;
		error.value = null;
		failureTail.value = [];
		secretsRemoved.value = false;
		stage.value = 'provisioning';
		try {
			const t = await getTransport();

			// system-check — detect Docker and the server's CPU architecture
			// (local image builds must target it).
			dockerPresent = false;
			let serverArch = 'x86_64';
			await runExecStep(sessionId, 'system-check', systemCheckCommand(), (line) => {
				if (line.includes('docker=yes')) dockerPresent = true;
				const arch = line.match(/^arch=(\S+)/);
				if (arch?.[1]) serverArch = arch[1];
			});

			// install-docker — only when missing.
			if (dockerPresent) {
				setStepState(steps, 'install-docker', 'skipped', 'already installed');
			} else {
				await runExecStep(sessionId, 'install-docker', installDockerCommand());
			}

			const source = installSource(remote);
			if (source !== 'git' && remote.localSource) {
				// fetch-owlat — upload the local working tree instead of cloning
				// (dev mode: nothing published yet, or testing local script changes).
				setStepState(steps, 'fetch-owlat', 'running');
				const prep = await t.execStream(sessionId, prepareInstallDirCommand(remote), (e: ExecEvent) => {
					if (e.kind !== 'exit') pushLog(e.kind, e.line);
				});
				if (prep !== 0) {
					setStepState(steps, 'fetch-owlat', 'failed', `exit ${prep}`);
					throw new Error(`"fetch-owlat" failed (exit ${prep}).`);
				}
				await t.uploadDir(sessionId, remote.localSource, remote.installDir);
				setStepState(steps, 'fetch-owlat', 'ok', 'uploaded local working tree');

				if (source === 'local-push') {
					// build-images-local — every stack image, built HERE for the
					// server's platform (cross-built via Rosetta/qemu when they differ).
					const platform = dockerPlatform(serverArch);
					setStepState(steps, 'build-images-local', 'running', platform);
					const stack = localBuildInvocation(platform);
					const onLine = (e: ExecEvent) => {
						if (e.kind !== 'exit') pushLog(e.kind, e.line);
					};
					const buildCode = await t.localExec(stack.program, stack.args, remote.localSource, stack.env, onLine);
					if (buildCode !== 0) {
						setStepState(steps, 'build-images-local', 'failed', `exit ${buildCode}`);
						throw new Error(`Local image build failed (exit ${buildCode}). Is Docker running here?`);
					}
					const setup = localSetupImageInvocation(platform);
					const setupCode = await t.localExec(setup.program, setup.args, remote.localSource, setup.env, onLine);
					if (setupCode !== 0) {
						setStepState(steps, 'build-images-local', 'failed', `exit ${setupCode}`);
						throw new Error(`Local setup-image build failed (exit ${setupCode}).`);
					}
					setStepState(steps, 'build-images-local', 'ok', platform);

					// push-images — docker save → gzip → ssh → docker load.
					setStepState(steps, 'push-images', 'running');
					await t.pushImages(sessionId, [...DEV_IMAGES], onLine);
					setStepState(steps, 'push-images', 'ok');
				} else {
					// build-setup-image — quickstart runs inside this image, so it must
					// exist on the server before the installer step (it is never pulled).
					await runExecStep(sessionId, 'build-setup-image', buildSetupImageCommand(remote));
				}
			} else {
				// fetch-owlat — clone or fast-forward the repo.
				await runExecStep(sessionId, 'fetch-owlat', fetchOwlatCommand(remote));
			}

			// upload-config — write the generated setup config.
			setStepState(steps, 'upload-config', 'running');
			await t.writeFile(sessionId, setupConfigPath(remote.installDir), JSON.stringify(config, null, 2));
			setStepState(steps, 'upload-config', 'ok');

			// installer — drives all server steps via NDJSON.
			setStepState(steps, 'finish', 'running');
			let done = false;
			const code = await t.execStream(sessionId, installerCommand(remote), (e: ExecEvent) => {
				if (e.kind === 'exit') return;
				if (e.kind === 'stdout') {
					const ev = parseProgressLine(e.line);
					if (ev) {
						if (ev.event === 'step') applyStepEvent(steps, ev);
						else if (ev.event === 'log') pushLog(ev.stream, ev.line);
						else if (ev.event === 'done') {
							done = true;
							if (ev.summary) summary.value = ev.summary;
							setStepState(steps, 'finish', ev.ok ? 'ok' : 'failed');
						}
						return;
					}
				}
				pushLog(e.kind, e.line);
			});

			if (code !== 0 || !done) {
				setStepState(steps, 'finish', 'failed');
				throw new Error(`Provisioning did not complete (exit ${code}).`);
			}

			// The uploaded config held the admin password + provider keys in
			// plaintext; quickstart has consumed it, so wipe it over the same
			// session. Best-effort: a failed cleanup must not fail the install.
			await removeSetupConfig(sessionId);

			stage.value = 'done';
		} catch (e) {
			fail(messageOf(e));
		} finally {
			busy.value = false;
		}
	}

	/** Delete the plaintext setup config from the server (best-effort, never fatal). */
	async function removeSetupConfig(sessionId: string): Promise<void> {
		try {
			const t = await getTransport();
			const code = await t.execStream(sessionId, removeSetupConfigCommand(remote.installDir), () => {});
			secretsRemoved.value = code === 0;
		} catch {
			secretsRemoved.value = false;
		}
	}

	/**
	 * The IP to render in the DNS A records: the SSH address when it is already
	 * an IP, else the auto-detected public IP, else null (the table then shows a
	 * flagged manual-paste placeholder). Recomputes when detection lands a value.
	 */
	const serverIp = computed(() => resolveServerIp(creds?.host ?? '', publicIp.value));

	/** The provisioned instance's public URL, if the installer reported one. */
	const siteUrl = computed(() => (summary.value?.['siteUrl'] as string | undefined) ?? null);

	/**
	 * Whether the success state may offer "Open workspace" yet: a public
	 * (non-loopback) URL that we have confirmed actually answers. The installer
	 * finishing is NOT the same as the public URL being usable (DNS/TLS lag).
	 */
	const canOpenWorkspace = computed(() => canOpenWorkspaceUrl(siteUrl.value, siteReachable.value));

	/**
	 * Probe the provisioned site for an owlat instance. Loopback URLs are never
	 * reachable from the desktop (their `localhost` is the app's own machine), so
	 * they short-circuit to unreachable without a network round-trip.
	 */
	async function verifySiteReachable(): Promise<boolean> {
		const url = siteUrl.value;
		if (!url || isLoopbackUrl(url)) {
			siteReachable.value = false;
			return false;
		}
		try {
			const res = await fetch(`${url}/api/instance-info`, { credentials: 'omit' });
			siteReachable.value = res.ok;
		} catch {
			siteReachable.value = false;
		}
		return siteReachable.value;
	}

	/** Connect the freshly-provisioned server as a workspace (reuses the handshake). */
	async function connectWorkspace(): Promise<void> {
		const url = siteUrl.value;
		// Never open a URL the app can't reach: a loopback or not-yet-resolvable
		// address opens the system browser to a dead page and fails silently.
		if (!url || !canOpenWorkspace.value) return;
		const { useDesktopWorkspaces } = await import('~/composables/useDesktopWorkspaces');
		await useDesktopWorkspaces().addWorkspace(url);
	}

	async function disconnect(): Promise<void> {
		if (!connectInfo.value) return;
		try {
			const t = await getTransport();
			await t.disconnect(connectInfo.value.sessionId);
		} catch {
			// best-effort
		}
	}

	/**
	 * Reset the timeline + logs to try provisioning again after a failure, keeping
	 * the live SSH session so the user can tweak their config and re-run without
	 * re-entering credentials. Falls back to the start if the session was lost.
	 */
	function retry(): void {
		steps.splice(0, steps.length, ...createTimeline(installSource(remote)));
		if (connectInfo.value) {
			setStepState(steps, 'ssh-connect', 'ok');
			setStepState(steps, 'host-key', 'ok');
			setStepState(steps, 'authenticate', 'ok', creds?.username);
		}
		logs.value = [];
		summary.value = null;
		error.value = null;
		failureTail.value = [];
		secretsRemoved.value = false;
		siteReachable.value = false;
		stage.value = connectInfo.value ? 'configure' : 'idle';
	}

	const progress = computed(() => {
		const done = steps.filter((s) => s.state === 'ok' || s.state === 'warn' || s.state === 'skipped').length;
		return Math.round((done / steps.length) * 100);
	});

	return {
		stage: readonly(stage),
		steps,
		logs,
		connectInfo: readonly(connectInfo),
		summary: readonly(summary),
		error: readonly(error),
		failureTail: readonly(failureTail),
		secretsRemoved: readonly(secretsRemoved),
		busy: readonly(busy),
		progress,
		siteUrl,
		siteReachable: readonly(siteReachable),
		publicIp: readonly(publicIp),
		serverIp,
		canOpenWorkspace,
		connect,
		acceptHostKey,
		provision,
		verifySiteReachable,
		connectWorkspace,
		disconnect,
		retry,
	};
}

function messageOf(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === 'string') return e;
	return 'Something went wrong.';
}
