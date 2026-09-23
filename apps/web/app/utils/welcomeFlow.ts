/**
 * Pure logic for the first-login welcome flow and the resumable per-user
 * onboarding checklist.
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
 * The onboarding steps the checklist can render. Mostly a subset of the backend
 * `ONBOARDING_STEPS` union (`auth/userOnboarding.ts`): the two intermediate
 * import phases (`importStarted`/`importDone`) collapse to a single "bring your
 * email over" row keyed on `importDone`.
 *
 * `aiConnected` is the exception — it is NOT a backend onboarding stamp. Its
 * completion is derived at render time from the instance's AI configuration
 * gap (`workspaces.featureFlags.getFlagsConfigStatus` — the `ai` flag is absent
 * from the gap map once a provider is configured by EITHER `LLM_*` env OR a
 * stored key), so an env-only self-hoster and a UI-configured org both mark it
 * done for every member of the instance. {@link AI_CONNECTED_STEP_ID} names it
 * for the one component that special-cases its completion source.
 */
export type ChecklistStepId =
	| 'mailboxReady'
	| 'aiConnected'
	| 'importDone'
	| 'knowledgeIndexed'
	| 'sendingSwitched'
	| 'firstSendDone'
	| MemberStepId;

/**
 * The three steps a regular member is asked for: the name people see, a
 * signature, and how much to be notified about. They are exactly what the
 * fresh-start welcome form sets, so each links there. Their completion is read
 * from real state (the mailbox's display name, its signatures, the
 * notification setting), not from a `userOnboarding` stamp.
 */
export type MemberStepId = 'profileName' | 'signature' | 'notifications';

/** The steps whose completion IS a `userOnboarding` stamp on the backend. */
export type StampedChecklistStepId = Exclude<ChecklistStepId, MemberStepId | 'aiConnected'>;

/**
 * Who the personal checklist is for. A member sees only their own three steps
 * (plus the import steps when the instance is bringing mail over); everything
 * that touches instance setup — the AI provider, mailbox provisioning, the
 * first test send — stays with admins.
 */
export type ChecklistAudience = 'admin' | 'member';

/**
 * The single checklist step whose completion is sourced from the org's
 * AI-provider config rather than a per-user `userOnboarding` stamp. Exported so
 * `UserChecklist.vue` can special-case it without a magic string, and so the
 * distinction is testable.
 */
export const AI_CONNECTED_STEP_ID = 'aiConnected' as const satisfies ChecklistStepId;

/**
 * Whether the org-scoped `aiConnected` step is complete, derived from the
 * per-flag config-gap map returned by
 * `workspaces.featureFlags.getFlagsConfigStatus`. That backend query lists the
 * `ai` flag ONLY while AI is unconfigured, and treats env (`LLM_*`) OR a stored
 * provider key as satisfying config — so the flag's ABSENCE from the map means a
 * provider is configured either way, which is exactly when this step is done.
 *
 * While the query is still loading the map is `undefined`; that is "not yet
 * known", NOT configured, so we require a defined map before reporting done —
 * otherwise the step would flash complete on first paint.
 */
export function isAiConnected(configGapStatus: Record<string, string[]> | undefined): boolean {
	return configGapStatus !== undefined && !('ai' in configGapStatus);
}

export interface ChecklistStepMeta {
	id: ChecklistStepId;
	/** i18n key — this module is module scope, so it never calls `useI18n`. */
	title: string;
	/** i18n key. */
	description: string;
	/** Where the CTA navigates to resume this step. */
	href: string;
	/** i18n key. */
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
		title: 'shared.welcomeFlow.steps.mailboxReady.title',
		description: 'shared.welcomeFlow.steps.mailboxReady.description',
		// The mail context, not a Preferences leaf. This used to eject the member
		// from onboarding into `/dashboard/preferences/add-account` — a settings
		// page under the preferences layout, three levels away from the mail they
		// were promised. `/dashboard/postbox/migrate` is the connect flow that
		// lives INSIDE the postbox, and its connect step is literally what marks
		// this stamp (`mail/external/accounts.ts` stamps `mailboxReady` when an
		// account is connected), so the step and its destination agree. Where
		// external mailboxes are turned off the page explains itself in place
		// rather than redirecting, so this is never a dead end.
		href: '/dashboard/postbox/migrate',
		cta: 'shared.welcomeFlow.steps.mailboxReady.cta',
		icon: 'lucide:mailbox',
		migrationOnly: false,
	},
	{
		id: 'aiConnected',
		title: 'shared.welcomeFlow.steps.aiConnected.title',
		description: 'shared.welcomeFlow.steps.aiConnected.description',
		href: '/dashboard/admin/instance/ai-provider',
		cta: 'shared.welcomeFlow.steps.aiConnected.cta',
		icon: 'lucide:sparkles',
		migrationOnly: false,
	},
	{
		id: 'importDone',
		title: 'shared.welcomeFlow.steps.importDone.title',
		description: 'shared.welcomeFlow.steps.importDone.description',
		href: '/dashboard/postbox/migrate',
		cta: 'shared.welcomeFlow.steps.importDone.cta',
		icon: 'lucide:import',
		migrationOnly: true,
	},
	{
		id: 'knowledgeIndexed',
		title: 'shared.welcomeFlow.steps.knowledgeIndexed.title',
		description: 'shared.welcomeFlow.steps.knowledgeIndexed.description',
		href: '/dashboard/postbox/migrate',
		cta: 'common.continue',
		icon: 'lucide:sparkles',
		migrationOnly: true,
	},
	{
		id: 'sendingSwitched',
		title: 'shared.welcomeFlow.steps.sendingSwitched.title',
		description: 'shared.welcomeFlow.steps.sendingSwitched.description',
		href: '/dashboard/preferences/external-account#postbox-sending-heading',
		cta: 'shared.welcomeFlow.steps.sendingSwitched.cta',
		icon: 'lucide:refresh-cw',
		migrationOnly: true,
	},
	{
		id: 'firstSendDone',
		title: 'shared.welcomeFlow.steps.firstSendDone.title',
		description: 'shared.welcomeFlow.steps.firstSendDone.description',
		href: '/dashboard/postbox',
		cta: 'shared.welcomeFlow.steps.firstSendDone.cta',
		icon: 'lucide:send',
		migrationOnly: false,
	},
] as const;

/** A member's own steps, in the order the welcome form asks for them. */
export const MEMBER_STEPS: readonly ChecklistStepMeta[] = [
	{
		id: 'profileName',
		title: 'shared.welcomeFlow.steps.profileName.title',
		description: 'shared.welcomeFlow.steps.profileName.description',
		href: '/welcome',
		cta: 'shared.welcomeFlow.steps.profileName.cta',
		icon: 'lucide:user-round',
		migrationOnly: false,
	},
	{
		id: 'signature',
		title: 'shared.welcomeFlow.steps.signature.title',
		description: 'shared.welcomeFlow.steps.signature.description',
		href: '/welcome',
		cta: 'shared.welcomeFlow.steps.signature.cta',
		icon: 'lucide:signature',
		migrationOnly: false,
	},
	{
		id: 'notifications',
		title: 'shared.welcomeFlow.steps.notifications.title',
		description: 'shared.welcomeFlow.steps.notifications.description',
		href: '/welcome',
		cta: 'shared.welcomeFlow.steps.notifications.cta',
		icon: 'lucide:bell',
		migrationOnly: false,
	},
] as const;

/**
 * The checklist steps visible for `mode` and `audience`. In fresh-start mode
 * the import and post-import steps are hidden entirely; in migration mode they
 * show for everyone, because bringing your own mail over is personal. A member
 * otherwise sees only {@link MEMBER_STEPS}; an admin sees the full list.
 */
export function visibleChecklistSteps(
	mode: OnboardingMode,
	audience: ChecklistAudience = 'admin'
): ChecklistStepMeta[] {
	if (audience === 'member') {
		const migration =
			mode === 'migration' ? CHECKLIST_STEPS.filter((step) => step.migrationOnly) : [];
		return [...MEMBER_STEPS, ...migration];
	}
	return CHECKLIST_STEPS.filter((step) => mode === 'migration' || !step.migrationOnly);
}

/** The real state each non-stamp step's completion is read from. */
export interface ChecklistSignals {
	/** The member's `userOnboarding` row (`null`/`undefined` before the first write). */
	stamps: Partial<Record<StampedChecklistStepId, number | null | undefined>> | null | undefined;
	/** An AI provider is configured for the instance (see {@link isAiConnected}). */
	aiConfigured: boolean;
	/** The member's mailbox carries a display name. */
	hasDisplayName: boolean;
	/** The member's mailbox has at least one signature. */
	hasSignature: boolean;
	/**
	 * The member chose a notification scope: either saved one explicitly or
	 * finished the welcome form, where the choice is confirmed.
	 */
	hasChosenNotifications: boolean;
}

function isStepComplete(id: ChecklistStepId, signals: ChecklistSignals): boolean {
	switch (id) {
		case 'aiConnected':
			return signals.aiConfigured;
		case 'profileName':
			return signals.hasDisplayName;
		case 'signature':
			return signals.hasSignature;
		case 'notifications':
			return signals.hasChosenNotifications;
		default:
			return (signals.stamps?.[id] ?? null) !== null;
	}
}

/** The completed subset of the steps visible for `mode` and `audience`. */
export function completedChecklistSteps(
	mode: OnboardingMode,
	audience: ChecklistAudience,
	signals: ChecklistSignals
): Set<ChecklistStepId> {
	const done = new Set<ChecklistStepId>();
	for (const step of visibleChecklistSteps(mode, audience)) {
		if (isStepComplete(step.id, signals)) done.add(step.id);
	}
	return done;
}

/**
 * Whether the checklist has nothing left to do: every VISIBLE step for the mode
 * is complete. A completed checklist section disappears for good (see
 * `buildGettingStarted` in `~/utils/gettingStarted`).
 */
export function isChecklistComplete(
	mode: OnboardingMode,
	completed: ReadonlySet<ChecklistStepId>,
	audience: ChecklistAudience = 'admin'
): boolean {
	return visibleChecklistSteps(mode, audience).every((step) => completed.has(step.id));
}

/**
 * First-login test used by the welcome middleware. Returns true only while the
 * member has never seen the welcome screen (`welcomedAt` unset). A returning
 * user — whose row carries a `welcomedAt` stamp — is never routed to `/welcome`
 * again, regardless of how much of the checklist they have or haven't done.
 *
 * This governs the AUTOMATIC route only. The screen itself is not one-shot: the
 * checklist carries a permanent "Finish setting up" entry back to it
 * (`FINISH_SETUP_STEP` in `~/utils/gettingStarted`), so clicking "I'll do this
 * later" once no longer puts the guided setup out of reach forever.
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
	return (
		path === '/dashboard/postbox' ||
		path.startsWith('/dashboard/postbox/') ||
		path === '/dashboard/preferences' ||
		path.startsWith('/dashboard/preferences/')
	);
}
