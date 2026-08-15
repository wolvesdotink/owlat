/**
 * The provisioning timeline for the desktop "set up a new server" flow: the
 * canonical, ordered roadmap of steps (desktop SSH steps plus the server-side
 * steps that arrive as `@@OWLAT_PROGRESS@@` NDJSON from the installer), and the
 * two folds that move a step's state — `applyStepEvent` for the installer's
 * events, `setStepState` for the desktop-driven ones.
 *
 * Split from `provisioning.ts` (transport + hostnames + host-key guards), which
 * consumes and re-exports these; the wizard composable drives them. Pure and
 * framework-free, so the whole roadmap is unit testable without SSH.
 */
import { SetupStep, type ProgressStepEvent } from '@owlat/shared/setupProgress';
import type { InstallSource } from './provisioningCommands';

export type StepState = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped';
export type StepGroup = 'connect' | 'server' | 'finish';

export interface TimelineStep {
	id: string;
	/** i18n key — the timeline component translates it. */
	title: string;
	group: StepGroup;
	state: StepState;
	/** Raw text streamed up from the installer; never a message key. */
	detail?: string;
}

interface TimelineSpec {
	id: string;
	/** i18n key. */
	title: string;
	group: StepGroup;
}

/**
 * The full ordered roadmap, shown up-front so the user can see what's done,
 * what's running, and what's still to come. The `server` ids match
 * `SetupStep` so the installer's NDJSON drives them directly.
 */
export const PROVISION_TIMELINE: readonly TimelineSpec[] = [
	{ id: 'ssh-connect', title: 'shared.desktop.provisioning.timeline.sshConnect', group: 'connect' },
	{ id: 'host-key', title: 'shared.desktop.provisioning.timeline.hostKey', group: 'connect' },
	{
		id: 'authenticate',
		title: 'shared.desktop.provisioning.timeline.authenticate',
		group: 'connect',
	},
	{
		id: 'system-check',
		title: 'shared.desktop.provisioning.timeline.systemCheck',
		group: 'connect',
	},
	{
		id: 'install-docker',
		title: 'shared.desktop.provisioning.timeline.installDocker',
		group: 'connect',
	},
	{ id: 'fetch-owlat', title: 'shared.desktop.provisioning.timeline.fetchOwlat', group: 'connect' },
	{
		id: 'upload-config',
		title: 'shared.desktop.provisioning.timeline.uploadConfig',
		group: 'connect',
	},
	{
		id: SetupStep.Preflight,
		title: 'shared.desktop.provisioning.timeline.preflight',
		group: 'server',
	},
	{ id: SetupStep.Config, title: 'shared.desktop.provisioning.timeline.config', group: 'server' },
	{
		id: SetupStep.ComposeUp,
		title: 'shared.desktop.provisioning.timeline.composeUp',
		group: 'server',
	},
	{
		id: SetupStep.MtaIdentity,
		title: 'shared.desktop.provisioning.timeline.mtaIdentity',
		group: 'server',
	},
	{
		id: SetupStep.WaitConvex,
		title: 'shared.desktop.provisioning.timeline.waitConvex',
		group: 'server',
	},
	{
		id: SetupStep.AdminKey,
		title: 'shared.desktop.provisioning.timeline.adminKey',
		group: 'server',
	},
	{
		id: SetupStep.DeployFunctions,
		title: 'shared.desktop.provisioning.timeline.deployFunctions',
		group: 'server',
	},
	{ id: SetupStep.EnvSet, title: 'shared.desktop.provisioning.timeline.envSet', group: 'server' },
	{
		id: SetupStep.WaitRoutes,
		title: 'shared.desktop.provisioning.timeline.waitRoutes',
		group: 'server',
	},
	{
		id: SetupStep.BootstrapAdmin,
		title: 'shared.desktop.provisioning.timeline.bootstrapAdmin',
		group: 'server',
	},
	{
		id: SetupStep.SeedDemo,
		title: 'shared.desktop.provisioning.timeline.seedDemo',
		group: 'server',
	},
	{ id: 'finish', title: 'shared.desktop.provisioning.timeline.finish', group: 'finish' },
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
	if (fetch) fetch.title = 'shared.desktop.provisioning.timeline.fetchOwlatLocal';
	const at = steps.findIndex((s) => s.id === 'upload-config');
	const inserted: TimelineStep[] =
		source === 'local-push'
			? [
					{
						id: 'build-images-local',
						title: 'shared.desktop.provisioning.timeline.buildImagesLocal',
						group: 'connect',
						state: 'pending',
					},
					{
						id: 'push-images',
						title: 'shared.desktop.provisioning.timeline.pushImages',
						group: 'connect',
						state: 'pending',
					},
				]
			: [
					{
						id: 'build-setup-image',
						title: 'shared.desktop.provisioning.timeline.buildSetupImage',
						group: 'connect',
						state: 'pending',
					},
				];
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
export function setStepState(
	steps: TimelineStep[],
	id: string,
	state: StepState,
	detail?: string
): void {
	const step = steps.find((s) => s.id === id);
	if (!step) return;
	step.state = state;
	if (detail !== undefined) step.detail = detail;
}
