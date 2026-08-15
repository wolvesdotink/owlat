/**
 * Pure model for the single, adaptive "Getting started" dashboard surface.
 *
 * This REPLACES the three previously-stacked onboarding surfaces (the self-host
 * banner, the instance go-live checklist, and the per-user checklist), each of
 * which had its own visibility gate and — worse — TWO different dismissal scopes.
 * An admin who was also a first-time user could meet three different affordances
 * across their first session. This module collapses all of that into ONE surface
 * whose contents adapt to:
 *
 * - the VIEWER: an admin/owner sees the instance go-live steps AND, when they are
 *   also a fresh member, their personal setup steps — in one card. A plain member
 *   sees only their personal steps (instance setup is not theirs to do).
 * - the instance MODE: `fresh` vs `migration` decides which personal steps show
 *   (import / "AI learns your history" / the post-import sending switch appear
 *   only when bringing mail over — see {@link visibleChecklistSteps}).
 *
 * The honest, derive-from-real-state completion logic is UNCHANGED and still
 * lives in the backend (`auth/onboarding.ts` for the instance flags,
 * `auth/userOnboarding.ts` for per-user stamps). This module only decides
 * PRESENTATION: which steps to show, in what order, whether the card is visible,
 * and — the key unification — the single dismissal scope that one "dismiss"
 * action must cover.
 *
 * Kept as pure functions so the consolidation is unit-testable without mounting
 * Vue or a Convex client.
 */
import {
	isChecklistComplete,
	visibleChecklistSteps,
	type ChecklistStepId,
	type OnboardingMode,
} from '~/utils/welcomeFlow';

/** Whether the viewer can drive instance-wide setup. */
export type ViewerRole = 'admin' | 'member';

/**
 * Which backend records a single "dismiss" action must clear. Because the card
 * can show admin (instance-scoped) and personal (per-user) steps at once, a
 * dismiss has to cover whatever is currently on screen — that is the "one
 * coherent dismissal model" the plan calls for.
 * - `instance` — only the instance go-live steps are showing.
 * - `user` — only the personal steps are showing.
 * - `both` — an admin sees both sections; dismiss clears both records.
 * - `none` — nothing to dismiss (card not visible).
 */
export type DismissalScope = 'none' | 'instance' | 'user' | 'both';

/** The instance go-live steps whose completion comes from `auth/onboarding.ts`. */
export type InstanceFlagId =
	| 'sendPathReady'
	| 'addedContacts'
	| 'createdEmail'
	| 'sentCampaign'
	| 'createdApiKey'
	| 'setupDomain';

/**
 * A piece of copy this module hands back, as the catalog key that carries it —
 * plus the values to interpolate when it takes any. This module is module scope
 * and never calls `useI18n`; `GettingStarted.vue` is the render boundary that
 * words every step it is given.
 */
export type GettingStartedMessage = string | { key: string; params?: Record<string, unknown> };

export interface GettingStartedStep {
	id: string;
	title: GettingStartedMessage;
	description: GettingStartedMessage;
	/** Where the CTA navigates to do / resume this step. */
	href: string;
	cta: GettingStartedMessage;
	icon: string;
	completed: boolean;
	/**
	 * The member cannot do this step yet — something outside their control is
	 * missing. A blocked step renders as an honest waiting state (no CTA into a
	 * dead end) and unblocks itself the moment the reason goes away.
	 */
	blocked?: boolean;
	/** What is being waited on, shown in place of the CTA. Set iff `blocked`. */
	blockedReason?: GettingStartedMessage;
}

export interface GettingStartedSection {
	id: 'instance' | 'personal';
	title: GettingStartedMessage;
	description: GettingStartedMessage;
	steps: GettingStartedStep[];
}

export interface GettingStartedModel {
	/** Whether the card renders at all. */
	visible: boolean;
	/** Ordered sections to render (instance first, then personal). */
	sections: GettingStartedSection[];
	/** Which backend records the single dismiss action must clear. */
	dismissalScope: DismissalScope;
	completedCount: number;
	totalCount: number;
	/**
	 * Whether to render the self-host resource links (Convex dashboard, docs)
	 * beneath the instance steps. True only while the instance section is active
	 * on a self-hosted deployment.
	 */
	showSelfHostResources: boolean;
}

/**
 * The two pre-send halves of go-live — a configured transport (`sendPathReady`)
 * and a verified sending domain (`setupDomain`) — are NOT re-listed here as
 * separate steps. They now meet in ONE place: the Delivery hub's readiness panel,
 * which derives a single "can this instance send?" truth from both. This surface
 * defers to it with the single {@link READY_TO_SEND_STEP} below, so the two
 * halves are never re-asserted as if the wizard never ran. Its completion still
 * comes from the same backend flags (both must be true), keeping the honest,
 * server-derived truth intact.
 */
export const READY_TO_SEND_STEP: Omit<GettingStartedStep, 'completed'> = {
	id: 'readyToSend',
	title: 'shared.gettingStarted.readyToSend.title',
	description: 'shared.gettingStarted.readyToSend.description',
	icon: 'lucide:send',
	href: '/dashboard/admin/delivery',
	cta: 'shared.gettingStarted.readyToSend.cta',
};

/**
 * The remaining instance go-live steps, in the order they were shown in the old
 * OnboardingChecklist (minus the two pre-send halves, now owned by
 * {@link READY_TO_SEND_STEP}). Preserved verbatim so no step is lost in the merge.
 */
interface InstanceStepMeta extends Omit<GettingStartedStep, 'completed' | 'id'> {
	id: InstanceFlagId;
}

export const INSTANCE_STEPS: readonly InstanceStepMeta[] = [
	{
		id: 'addedContacts',
		title: 'shared.gettingStarted.addedContacts.title',
		description: 'shared.gettingStarted.addedContacts.description',
		icon: 'lucide:users',
		href: '/dashboard/audience/contacts',
		cta: 'shared.gettingStarted.addedContacts.cta',
	},
	{
		id: 'createdEmail',
		title: 'shared.gettingStarted.createdEmail.title',
		description: 'shared.gettingStarted.createdEmail.description',
		icon: 'lucide:file-text',
		href: '/dashboard/send/marketing',
		cta: 'shared.gettingStarted.createdEmail.cta',
	},
	{
		id: 'sentCampaign',
		title: 'shared.gettingStarted.sentCampaign.title',
		description: 'shared.gettingStarted.sentCampaign.description',
		icon: 'lucide:megaphone',
		href: '/dashboard/campaigns/new',
		cta: 'shared.gettingStarted.sentCampaign.cta',
	},
	{
		id: 'createdApiKey',
		title: 'shared.gettingStarted.createdApiKey.title',
		description: 'shared.gettingStarted.createdApiKey.description',
		icon: 'lucide:key',
		href: '/dashboard/admin/team/api',
		cta: 'shared.gettingStarted.createdApiKey.cta',
	},
];

/**
 * The optional backups step (platform-admin only, self-host, until a schedule is
 * recorded). Carried over from the old self-host banner: a fresh install with no
 * backup plan is a real gap, so it becomes one of the admin's go-live steps.
 */
export const BACKUPS_STEP: Omit<GettingStartedStep, 'completed'> = {
	id: 'backupsScheduled',
	title: 'shared.gettingStarted.backups.title',
	description: 'shared.gettingStarted.backups.description',
	icon: 'lucide:database-backup',
	href: '/dashboard/admin/backups',
	cta: 'shared.gettingStarted.backups.cta',
};

export interface GettingStartedInput {
	role: ViewerRole;
	isSelfHost: boolean;
	mode: OnboardingMode;
	/** True while any underlying state is still loading — the card stays hidden. */
	isLoading: boolean;
	/** Instance go-live state (from `auth/onboarding.ts`). */
	instanceDismissed: boolean;
	instanceComplete: boolean;
	instanceFlags: Readonly<Record<InstanceFlagId, boolean>>;
	/** True when the admin should still be prompted to schedule backups. */
	showBackupsStep: boolean;
	/** Per-user state (from `auth/userOnboarding.ts`). */
	userDismissed: boolean;
	/** The resolved set of completed personal step ids (incl. derived aiConnected). */
	personalCompleted: ReadonlySet<ChecklistStepId>;
	/**
	 * Whether the instance can actually deliver mail (member-safe read of the
	 * same signal as the admin `sendPathReady` flag). While false, the personal
	 * send steps are BLOCKED rather than merely open — see
	 * {@link SEND_BLOCKED_STEP_IDS}.
	 */
	sendPathReady: boolean;
	/**
	 * Campaign volume still sendable TODAY under the IP warm-up cap, or `null`
	 * when there is no cap to quote / it could not be measured. Folded into the
	 * "Send a campaign" step so the ramp is visible before a campaign is built
	 * around an audience it cannot carry — see {@link sentCampaignDescription}.
	 */
	sendCapacityToday: number | null;
}

/**
 * The personal steps a member cannot complete without an instance-wide outbound
 * transport. Sending from Owlat is silently dropped without one, so these must
 * never be presented as a check the member is failing to tick — they are shown
 * as waiting on setup, and unblock themselves as soon as sending works.
 */
export const SEND_BLOCKED_STEP_IDS: ReadonlySet<ChecklistStepId> = new Set([
	'sendingSwitched',
	'firstSendDone',
]);

/** What a send-blocked step shows in place of its CTA. */
export const SEND_BLOCKED_REASON = 'shared.gettingStarted.sendBlockedReason';

/**
 * The "Send a campaign" description, with today's real sending headroom folded
 * in when it is known (`campaigns/sendingReadiness.ts` measures it off the same
 * paced warming projection the send gate meters against).
 *
 * The point is that a warming deployment's cap is met HERE — on the way in —
 * rather than as a pre-flight refusal after the operator has built a campaign
 * for an audience today's capacity cannot carry. `null` is "not measured, or no
 * cap applies", and then the step says nothing extra: an invented number beside
 * a checklist item is worse than no number (deliverability plan D14).
 *
 * WHY THIS IS NOT `sendReadinessNote`. That helper (`~/lib/sendReadiness`)
 * builds the same measurement into a two-line NOTE — a heading and a detail —
 * for the surfaces that render one beside a send button. A checklist step has
 * one description to extend and no audience to compare against, so it needs the
 * number as a clause rather than a heading, and it is the only surface that has
 * to explain the limit at all ("while your IPs warm up") because it has no
 * capacity panel beside it. The NUMBER is single-sourced — both read
 * `campaigns/sendingReadiness.ts` — the sentence around it is not.
 */
export function sentCampaignDescription(capacityToday: number | null): GettingStartedMessage {
	if (capacityToday === null) return 'shared.gettingStarted.sentCampaign.description';
	if (capacityToday <= 0) return 'shared.gettingStarted.sentCampaign.descriptionExhausted';
	return {
		key: 'shared.gettingStarted.sentCampaign.descriptionCapacity',
		// Grouped here rather than in the message: this module is locale-free, and
		// the number is the same one the send gate meters against.
		params: { count: capacityToday, capacity: capacityToday.toLocaleString() },
	};
}

const EMPTY_MODEL: GettingStartedModel = {
	visible: false,
	sections: [],
	dismissalScope: 'none',
	completedCount: 0,
	totalCount: 0,
	showSelfHostResources: false,
};

/**
 * Build the adaptive "Getting started" model. The instance section shows only
 * for admins and only while the instance onboarding is unfinished and not
 * dismissed; the personal section shows for anyone whose personal checklist is
 * unfinished and not dismissed. The card is visible when either section has
 * content, and the dismissal scope is the union of the active sections.
 */
export function buildGettingStarted(input: GettingStartedInput): GettingStartedModel {
	if (input.isLoading) return EMPTY_MODEL;

	const sections: GettingStartedSection[] = [];

	// Instance go-live section — admins only.
	const instanceActive =
		input.role === 'admin' && !input.instanceDismissed && !input.instanceComplete;
	if (instanceActive) {
		// Lead with the one readiness step that defers both pre-send halves to the
		// Delivery hub. It's done only when a transport AND a verified domain are
		// both in place — the same backend flags, now folded into one honest step.
		const steps: GettingStartedStep[] = [
			{
				...READY_TO_SEND_STEP,
				completed: input.instanceFlags.sendPathReady && input.instanceFlags.setupDomain,
			},
			...INSTANCE_STEPS.map((step) => ({
				...step,
				completed: input.instanceFlags[step.id],
				// The send step is the one whose feasibility depends on live warm-up
				// state, so it carries today's headroom rather than a static sentence.
				...(step.id === 'sentCampaign'
					? { description: sentCampaignDescription(input.sendCapacityToday) }
					: {}),
			})),
		];
		if (input.showBackupsStep && input.isSelfHost) {
			steps.push({ ...BACKUPS_STEP, completed: false });
		}
		sections.push({
			id: 'instance',
			title: 'shared.gettingStarted.instanceSection.title',
			description: 'shared.gettingStarted.instanceSection.description',
			steps,
		});
	}

	// Personal section — everyone with an unfinished personal checklist.
	const personalComplete = isChecklistComplete(input.mode, input.personalCompleted);
	const personalActive = !input.userDismissed && !personalComplete;
	if (personalActive) {
		const steps: GettingStartedStep[] = visibleChecklistSteps(input.mode).map((step) => {
			const completed = input.personalCompleted.has(step.id);
			// A send step with no transport behind it is blocked, not open: the
			// member has nothing to do until the instance can send. The block lifts
			// on its own the moment `sendPathReady` flips (the same edge that
			// notifies them — see `auth/sendReadyNotices.ts`).
			const blocked = !completed && !input.sendPathReady && SEND_BLOCKED_STEP_IDS.has(step.id);
			return {
				id: step.id,
				title: step.title,
				description: step.description,
				href: step.href,
				cta: step.cta,
				icon: step.icon,
				completed,
				...(blocked ? { blocked: true, blockedReason: SEND_BLOCKED_REASON } : {}),
			};
		});
		sections.push({
			id: 'personal',
			title: 'shared.gettingStarted.personalSection.title',
			description: 'shared.gettingStarted.personalSection.description',
			steps,
		});
	}

	if (sections.length === 0) return EMPTY_MODEL;

	let dismissalScope: DismissalScope = 'none';
	if (instanceActive && personalActive) dismissalScope = 'both';
	else if (instanceActive) dismissalScope = 'instance';
	else if (personalActive) dismissalScope = 'user';

	const allSteps = sections.flatMap((section) => section.steps);

	return {
		visible: true,
		sections,
		dismissalScope,
		completedCount: allSteps.filter((step) => step.completed).length,
		totalCount: allSteps.length,
		showSelfHostResources: instanceActive && input.isSelfHost,
	};
}
