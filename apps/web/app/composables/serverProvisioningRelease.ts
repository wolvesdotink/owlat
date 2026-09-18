/**
 * The RELEASE-RESOLUTION step of the desktop "set up a new server" wizard.
 *
 * The default install targets the newest published server release: the same
 * GitHub releases lookup `install.sh` performs, run on the server, whose result
 * becomes {@link RemoteOptions.version} so the fetch checks out the release tag
 * and the installer pins the signed images. A pinned version, a branch install
 * or a local checkout skips the lookup and marks the step as such.
 *
 * Split from `useServerProvisioning.ts` to keep that file under the size cap.
 * No Vue and no Tauri here: the composable owns the reactive timeline and the
 * translator and hands them in.
 */
import type { RemoteOptions, TimelineStep } from '~/lib/desktop/provisioning';
import {
	needsReleaseResolution,
	parseResolvedRelease,
	resolveLatestReleaseCommand,
	setStepState,
} from '~/lib/desktop/provisioning';

/** The active locale's translator, handed in by the composable. */
type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface ReleaseResolution {
	/** The live timeline; the `resolve-release` step is marked in place. */
	readonly steps: TimelineStep[];
	readonly remote: RemoteOptions;
	/** Run one exec step on the server, streaming to the log; throws on non-zero exit. */
	readonly runExecStep: (
		stepId: string,
		command: string,
		onLine?: (line: string, stream: 'stdout' | 'stderr') => void
	) => Promise<number>;
	readonly t: Translate;
}

/**
 * Returns the remote options to continue with: the input with `version` filled
 * in when the latest release was resolved, or the input unchanged when the
 * lookup does not apply. Throws when the lookup runs but yields no release —
 * the wizard fails rather than silently installing `main`.
 */
export async function resolveInstallRelease(ctx: ReleaseResolution): Promise<RemoteOptions> {
	const { steps, remote, runExecStep, t } = ctx;
	if (!needsReleaseResolution(remote)) {
		setStepState(
			steps,
			'resolve-release',
			'skipped',
			remote.version ? `v${remote.version}` : t('shared.useServerProvisioning.developmentInstall')
		);
		return remote;
	}
	let resolved: string | null = null;
	await runExecStep('resolve-release', resolveLatestReleaseCommand(remote), (line) => {
		resolved ??= parseResolvedRelease(line);
	});
	if (!resolved) {
		setStepState(steps, 'resolve-release', 'failed');
		throw new Error(t('shared.useServerProvisioning.releaseNotFound'));
	}
	setStepState(steps, 'resolve-release', 'ok', `v${resolved}`);
	return { ...remote, version: resolved };
}
