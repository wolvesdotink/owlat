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
	| 'firstSendDone';

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
		href: '/dashboard/preferences#postbox-sending-heading',
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

/**
 * The checklist steps visible for `mode`. In fresh-start mode the import and
 * post-import steps are hidden entirely; in migration mode every step shows.
 */
export function visibleChecklistSteps(mode: OnboardingMode): ChecklistStepMeta[] {
	return CHECKLIST_STEPS.filter((step) => mode === 'migration' || !step.migrationOnly);
}

/**
 * Whether the checklist has nothing left to do: every VISIBLE step for the mode
 * is complete. A completed checklist section disappears for good (see
 * `buildGettingStarted` in `~/utils/gettingStarted`).
 */
export function isChecklistComplete(
	mode: OnboardingMode,
	completed: ReadonlySet<ChecklistStepId>
): boolean {
	return visibleChecklistSteps(mode).every((step) => completed.has(step.id));
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
