/**
 * The release-compat ledger read by `check-entry-wiring.ts`, kept in its own
 * file so the ledger can grow and shrink release by release without touching
 * the walk.
 */

/**
 * RELEASE-COMPAT SHIMS — entries kept for one release so the PREVIOUS release's
 * code can still reach them: an action in flight across the deploy resolves its
 * `ctx.runMutation(internal.…)` calls against the new functions (CONVENTIONS.md,
 * "In-flight work across a deploy"). Nothing in this release calls them, so
 * they are orphans by design. Each line names the release whose code calls it;
 * the shim and its line go in the release after the one that ships them.
 * Exact in both directions, like the ledger: a listed shim that is deleted, or
 * that gains a caller, fails until its line comes off.
 */
export const RELEASE_COMPAT_ENTRIES: Readonly<Record<string, string>> = {
	'automations/lifecycle.ts#recordRunFailure': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#advanceAutomationRun': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#cancelAutomationRun': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#completeAutomationRun': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#createStepRun': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#getAutomationRunWithContact': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#getAutomationStep': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#getAutomationSteps': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#markStepCompleted': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#markStepExecuting': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#markStepFailed': 'v0.5.5 step walker',
	'automations/stepExecutorQueries.ts#markStepsSkipped': 'v0.5.5 step walker',
	'blockedEmails.ts#isBlockedInternal': 'v0.5.5 email worker',
};
