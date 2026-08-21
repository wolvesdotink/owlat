/**
 * The LOCAL-SOURCE install path of the desktop "set up a new server" wizard —
 * the dev modes where nothing has been published yet (or local script changes
 * are being tested), so the working tree on THIS machine is uploaded over SSH
 * instead of git-cloned.
 *
 * Two shapes, both handled here:
 *  - `local-build` — upload the tree, then build the setup image ON THE SERVER
 *    (quickstart runs inside it, and it is never pulled);
 *  - `local-push` — upload the tree, build every stack image HERE for the
 *    server's platform (cross-built via Rosetta/qemu when they differ), then
 *    stream them over (docker save → gzip → ssh → docker load).
 *
 * Split from `useServerProvisioning.ts` to keep that file under the size cap.
 * Everything it touches arrives as {@link LocalSourceInstall}, so this module has
 * no Vue and no Tauri in it: the composable owns the reactive timeline, the log
 * buffer and the translator, and hands them in. `t` is passed rather than called
 * because module scope has no `useI18n`.
 */
import type {
	ExecEvent,
	InstallSource,
	ProvisionTransport,
	RemoteOptions,
	TimelineStep,
} from '~/lib/desktop/provisioning';
import {
	buildSetupImageCommand,
	dockerPlatform,
	localBuildInvocation,
	localSetupImageInvocation,
	prepareInstallDirCommand,
	setStepState,
	DEV_IMAGES,
} from '~/lib/desktop/provisioning';

/** The active locale's translator, handed in by the composable. */
type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface LocalSourceInstall {
	readonly ssh: ProvisionTransport;
	readonly sessionId: string;
	/** The live timeline; steps are marked in place. */
	readonly steps: TimelineStep[];
	readonly remote: RemoteOptions;
	/**
	 * Absolute path to the monorepo root on THIS machine. Passed separately from
	 * {@link RemoteOptions.localSource} because the caller has already established
	 * it is set — this is the non-optional form of it.
	 */
	readonly localSource: string;
	/** Which local mode this is; `git` never reaches here. */
	readonly source: Exclude<InstallSource, 'git'>;
	/** The server's CPU architecture, from system-check — local builds target it. */
	readonly serverArch: string;
	readonly pushLog: (stream: 'stdout' | 'stderr', line: string) => void;
	/** Run one exec step on the server, streaming to the log; throws on non-zero exit. */
	readonly runExecStep: (stepId: string, command: string) => Promise<number>;
	readonly t: Translate;
}

/** Upload the local working tree into the install dir (the `fetch-owlat` step). */
async function uploadLocalSource(ctx: LocalSourceInstall): Promise<void> {
	const { ssh, sessionId, steps, remote, t } = ctx;
	setStepState(steps, 'fetch-owlat', 'running');
	const prep = await ssh.execStream(sessionId, prepareInstallDirCommand(remote), (e: ExecEvent) => {
		if (e.kind !== 'exit') ctx.pushLog(e.kind, e.line);
	});
	if (prep !== 0) {
		setStepState(
			steps,
			'fetch-owlat',
			'failed',
			t('shared.useServerProvisioning.exitCode', { code: prep })
		);
		throw new Error(
			t('shared.useServerProvisioning.stepFailed', { step: 'fetch-owlat', code: prep })
		);
	}
	await ssh.uploadDir(sessionId, ctx.localSource, remote.installDir);
	setStepState(steps, 'fetch-owlat', 'ok', t('shared.useServerProvisioning.uploadedLocalSource'));
}

/**
 * Build every stack image here for the server's platform, then stream them over
 * SSH. Two local invocations (the stack, then the setup image) share one step in
 * the timeline, because to the operator it is one wait.
 */
async function buildAndPushImages(ctx: LocalSourceInstall): Promise<void> {
	const { ssh, sessionId, steps, t } = ctx;
	const platform = dockerPlatform(ctx.serverArch);
	setStepState(steps, 'build-images-local', 'running', platform);
	const onLine = (e: ExecEvent) => {
		if (e.kind !== 'exit') ctx.pushLog(e.kind, e.line);
	};
	const stack = localBuildInvocation(platform);
	const buildCode = await ssh.localExec(
		stack.program,
		stack.args,
		ctx.localSource,
		stack.env,
		onLine
	);
	if (buildCode !== 0) {
		setStepState(
			steps,
			'build-images-local',
			'failed',
			t('shared.useServerProvisioning.exitCode', { code: buildCode })
		);
		throw new Error(t('shared.useServerProvisioning.localBuildFailed', { code: buildCode }));
	}
	const setup = localSetupImageInvocation(platform);
	const setupCode = await ssh.localExec(
		setup.program,
		setup.args,
		ctx.localSource,
		setup.env,
		onLine
	);
	if (setupCode !== 0) {
		setStepState(
			steps,
			'build-images-local',
			'failed',
			t('shared.useServerProvisioning.exitCode', { code: setupCode })
		);
		throw new Error(t('shared.useServerProvisioning.localSetupImageFailed', { code: setupCode }));
	}
	setStepState(steps, 'build-images-local', 'ok', platform);

	// push-images — docker save → gzip → ssh → docker load.
	setStepState(steps, 'push-images', 'running');
	await ssh.pushImages(sessionId, [...DEV_IMAGES], onLine);
	setStepState(steps, 'push-images', 'ok');
}

/**
 * Run the whole local-source path: upload the tree, then get the images the
 * installer needs onto the server the way this mode calls for.
 */
export async function installLocalSource(ctx: LocalSourceInstall): Promise<void> {
	await uploadLocalSource(ctx);
	if (ctx.source === 'local-push') {
		await buildAndPushImages(ctx);
		return;
	}
	// build-setup-image — quickstart runs inside this image, so it must exist on
	// the server before the installer step (it is never pulled).
	await ctx.runExecStep('build-setup-image', buildSetupImageCommand(ctx.remote));
}
