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
	/** Opens in a new tab (docs / external dashboard). */
	external?: boolean;
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
 * The instance go-live steps, in the order they were shown in the old
 * OnboardingChecklist. Preserved verbatim so no step is lost in the merge; the
 * `sendPathReady` + `setupDomain` steps also cover the old self-host banner's
 * "configure a sending provider" / "verify a sending domain" pre-send prompts.
 */
interface InstanceStepMeta extends Omit<GettingStartedStep, 'completed' | 'id'> {
	id: InstanceFlagId;
}

export const INSTANCE_STEPS: readonly InstanceStepMeta[] = [
	{
		id: 'sendPathReady',
		title: 'Configure a sending provider',
		description:
			'Set up a delivery provider so this instance can actually send email — then send a test.',
		icon: 'lucide:send',
		href: '/dashboard/delivery/config',
		cta: 'Set up sending',
	},
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
		href: '/dashboard/settings/api',
		cta: 'Create key',
	},
	{
		id: 'setupDomain',
		title: 'Set up a domain',
		description: 'Verify a sending domain (SPF, DKIM, DMARC) for deliverability.',
		icon: 'lucide:globe',
		href: '/dashboard/delivery/domains',
		cta: 'Add domain',
	},
] as const;

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
	href: '/dashboard/settings/backups',
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
		const steps: GettingStartedStep[] = INSTANCE_STEPS.map((step) => ({
			...step,
			completed: input.instanceFlags[step.id],
		}));
		if (input.showBackupsStep) {
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
		const steps: GettingStartedStep[] = visibleChecklistSteps(input.mode).map((step) => ({
			id: step.id,
			title: step.title,
			description: step.description,
			href: step.href,
			cta: step.cta,
			icon: step.icon,
			completed: input.personalCompleted.has(step.id),
		}));
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
