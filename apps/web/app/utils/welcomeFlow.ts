/**
 * Pure logic for the first-login welcome flow and the resumable per-user
 * onboarding checklist (piece c1).
 *
 * Everything the Vue components and the route middleware decide is derived from
 * these functions, so the behaviour is unit-testable without mounting Nuxt or a
 * Convex client:
 *
 * - {@link shouldRouteToWelcome} — the middleware's first-login test. A member is
 *   routed to `/welcome` exactly once: while their `userOnboarding` row has no
 *   `welcomedAt` stamp. Once the welcome screen records that stamp they are a
 *   "returning" user and never bounced there again.
 * - {@link isWelcomeTriggerPath} — the middleware only performs that check on the
 *   app's landing surfaces (the dashboard home + Postbox), never app-wide.
 * - {@link visibleChecklistSteps} / {@link isChecklistComplete} — the checklist
 *   ADAPTS to the instance mode: import + "AI learns your history" + the
 *   post-import sending switch appear only in migration mode; a fresh-start
 *   instance shows just the universal steps.
 */

/** Instance onboarding mode, derived from `instanceSettings.isMigrationMode`. */
export type OnboardingMode = 'fresh' | 'migration';

/**
 * The onboarding steps the checklist can render. A subset of the backend
 * `ONBOARDING_STEPS` union (`auth/userOnboarding.ts`): the two intermediate
 * import phases (`importStarted`/`importDone`) collapse to a single "bring your
 * email over" row keyed on `importDone`.
 */
export type ChecklistStepId =
	| 'mailboxReady'
	| 'importDone'
	| 'knowledgeIndexed'
	| 'sendingSwitched'
	| 'firstSendDone';

export interface ChecklistStepMeta {
	id: ChecklistStepId;
	title: string;
	description: string;
	/** Where the CTA navigates to resume this step. */
	href: string;
	cta: string;
	icon: string;
	/** Only meaningful when the instance is bringing mail over from elsewhere. */
	migrationOnly: boolean;
}

/**
 * Ordered checklist definition. `migrationOnly` steps are filtered out of a
 * fresh-start instance by {@link visibleChecklistSteps}.
 */
export const CHECKLIST_STEPS: readonly ChecklistStepMeta[] = [
	{
		id: 'mailboxReady',
		title: 'Set up your mailbox',
		description: 'Add a personal mailbox so you can send and receive mail here.',
		href: '/dashboard/postbox/settings/add-account',
		cta: 'Set up',
		icon: 'lucide:mailbox',
		migrationOnly: false,
	},
	{
		id: 'importDone',
		title: 'Bring your email over',
		description: 'Import your existing inbox so nothing is left behind.',
		href: '/dashboard/postbox/migrate',
		cta: 'Import',
		icon: 'lucide:import',
		migrationOnly: true,
	},
	{
		id: 'knowledgeIndexed',
		title: 'Let AI learn your history',
		description: 'We read your imported mail so drafts and replies sound like you.',
		href: '/dashboard/postbox/migrate',
		cta: 'Continue',
		icon: 'lucide:sparkles',
		migrationOnly: true,
	},
	{
		id: 'sendingSwitched',
		title: 'Switch sending to this instance',
		description: 'Start sending outbound mail from Owlat once your domain is verified.',
		href: '/dashboard/postbox/settings#postbox-sending-heading',
		cta: 'Switch',
		icon: 'lucide:refresh-cw',
		migrationOnly: true,
	},
	{
		id: 'firstSendDone',
		title: 'Send your first email',
		description: 'Write a message and hit send to make sure everything works.',
		href: '/dashboard/postbox',
		cta: 'Compose',
		icon: 'lucide:send',
		migrationOnly: false,
	},
] as const;

/**
 * The checklist steps visible for `mode`. In fresh-start mode the import and
 * post-import steps are hidden entirely; in migration mode every step shows.
 */
export function visibleChecklistSteps(mode: OnboardingMode): ChecklistStepMeta[] {
	return CHECKLIST_STEPS.filter((step) => mode === 'migration' || !step.migrationOnly);
}

/**
 * Whether the checklist has nothing left to do: every VISIBLE step for the mode
 * is complete. A completed checklist disappears for good (see
 * {@link shouldShowUserChecklist}).
 */
export function isChecklistComplete(
	mode: OnboardingMode,
	completed: ReadonlySet<ChecklistStepId>
): boolean {
	return visibleChecklistSteps(mode).every((step) => completed.has(step.id));
}

/**
 * Whether the per-user checklist card should render. It hides while state is
 * still loading, once the member dismisses it, and forever once every visible
 * step is complete.
 */
export function shouldShowUserChecklist(opts: {
	isLoading: boolean;
	dismissed: boolean;
	isComplete: boolean;
}): boolean {
	if (opts.isLoading) return false;
	if (opts.dismissed) return false;
	if (opts.isComplete) return false;
	return true;
}

/**
 * First-login test used by the welcome middleware. Returns true only while the
 * member has never seen the welcome screen (`welcomedAt` unset). A returning
 * user — whose row carries a `welcomedAt` stamp — is never routed to `/welcome`
 * again, regardless of how much of the checklist they have or haven't done.
 */
export function shouldRouteToWelcome(opts: { welcomedAt: number | null }): boolean {
	return opts.welcomedAt === null;
}

/**
 * The landing surfaces on which the welcome middleware performs its first-login
 * check: the dashboard home and anywhere in the Postbox. Restricting the check
 * to these keeps the extra query off every in-app navigation.
 */
export function isWelcomeTriggerPath(path: string): boolean {
	if (path === '/dashboard') return true;
	return path === '/dashboard/postbox' || path.startsWith('/dashboard/postbox/');
}
