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

export interface GettingStartedStep {
	id: string;
	title: string;
	description: string;
	/** Where the CTA navigates to do / resume this step. */
	href: string;
	cta: string;
	icon: string;
	completed: boolean;
	/**
	 * The member cannot do this step yet — something outside their control is
	 * missing. A blocked step renders as an honest waiting state (no CTA into a
	 * dead end) and unblocks itself the moment the reason goes away.
	 */
	blocked?: boolean;
	/** What is being waited on, shown in place of the CTA. Set iff `blocked`. */
	blockedReason?: string;
}

export interface GettingStartedSection {
	id: 'instance' | 'personal';
	title: string;
	description: string;
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
	title: 'Get ready to send',
	description:
		'Set up sending and verify your domain in one place — Delivery shows exactly what is left before mail can go out.',
	icon: 'lucide:send',
	href: '/dashboard/admin/delivery',
	cta: 'Open delivery',
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
		title: 'Add contacts',
		description: 'Import or add your first contact.',
		icon: 'lucide:users',
		href: '/dashboard/audience/contacts',
		cta: 'Add contacts',
	},
	{
		id: 'createdEmail',
		title: 'Create an email',
		description: 'Build an email template you can send.',
		icon: 'lucide:file-text',
		href: '/dashboard/send/marketing',
		cta: 'Create email',
	},
	{
		id: 'sentCampaign',
		title: 'Send a campaign',
		description: 'Send your first email campaign to your audience.',
		icon: 'lucide:megaphone',
		href: '/dashboard/campaigns/new',
		cta: 'New campaign',
	},
	{
		id: 'createdApiKey',
		title: 'Create an API key',
		description:
			'Send transactional email (receipts, password resets) programmatically via the API.',
		icon: 'lucide:key',
		href: '/dashboard/admin/team/api',
		cta: 'Create key',
	},
];

/**
 * The optional backups step (platform-admin only, self-host, until a schedule is
 * recorded). Carried over from the old self-host banner: a fresh install with no
 * backup plan is a real gap, so it becomes one of the admin's go-live steps.
 */
export const BACKUPS_STEP: Omit<GettingStartedStep, 'completed'> = {
	id: 'backupsScheduled',
	title: 'Set up backups',
	description: 'Nothing is backed up until you turn it on — do this before you store real data.',
	icon: 'lucide:database-backup',
	href: '/dashboard/admin/backups',
	cta: 'Set up backups',
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
export const SEND_BLOCKED_REASON = 'Waiting on sending setup';

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
export function sentCampaignDescription(capacityToday: number | null): string {
	const base = 'Send your first email campaign to your audience.';
	if (capacityToday === null) return base;
	if (capacityToday <= 0) {
		return `${base} Today's warm-up capacity is used up — schedule it and it goes out as capacity returns.`;
	}
	const contacts = capacityToday === 1 ? 'contact' : 'contacts';
	return `${base} About ${capacityToday.toLocaleString()} ${contacts} can be reached today while your IPs warm up.`;
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
			title: 'Get your instance ready',
			description: 'A few steps to go live — set up sending, then your first campaign.',
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
			title: 'Finish setting up your account',
			description: 'Pick up wherever you left off — nothing here is one-shot.',
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
