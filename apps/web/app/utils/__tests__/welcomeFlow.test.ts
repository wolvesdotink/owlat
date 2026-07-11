import { describe, it, expect } from 'vitest';
import {
	AI_CONNECTED_STEP_ID,
	CHECKLIST_STEPS,
	isAiConnected,
	isChecklistComplete,
	isWelcomeTriggerPath,
	shouldRouteToWelcome,
	visibleChecklistSteps,
	type ChecklistStepId,
} from '../welcomeFlow';

describe('shouldRouteToWelcome — first-login detection', () => {
	it('routes a brand-new member (no welcomedAt stamp) to the welcome screen', () => {
		// "No row" collapses to an all-null onboarding state, so welcomedAt is null.
		expect(shouldRouteToWelcome({ welcomedAt: null })).toBe(true);
	});

	it('never routes a returning member (welcomedAt stamped)', () => {
		expect(shouldRouteToWelcome({ welcomedAt: 1_720_000_000_000 })).toBe(false);
	});

	it('never routes a member who dismissed the checklist — they were welcomed first', () => {
		// Dismissing happens after the welcome screen recorded welcomedAt, so a
		// dismissed member always carries the stamp and is treated as returning.
		expect(shouldRouteToWelcome({ welcomedAt: 42 })).toBe(false);
	});
});

describe('isWelcomeTriggerPath — where the middleware checks', () => {
	it('triggers on the dashboard home', () => {
		expect(isWelcomeTriggerPath('/dashboard')).toBe(true);
	});

	it('triggers on the Postbox root and its subpaths', () => {
		expect(isWelcomeTriggerPath('/dashboard/postbox')).toBe(true);
		expect(isWelcomeTriggerPath('/dashboard/postbox/inbox')).toBe(true);
		expect(isWelcomeTriggerPath('/dashboard/postbox/settings/add-account')).toBe(true);
	});

	it('does not trigger on the welcome screen itself (no redirect loop)', () => {
		expect(isWelcomeTriggerPath('/welcome')).toBe(false);
	});

	it('does not trigger on unrelated dashboard or app routes', () => {
		expect(isWelcomeTriggerPath('/dashboard/settings')).toBe(false);
		expect(isWelcomeTriggerPath('/dashboard/campaigns')).toBe(false);
		expect(isWelcomeTriggerPath('/auth/login')).toBe(false);
		// A route that merely starts with the dashboard-home string is not the home.
		expect(isWelcomeTriggerPath('/dashboard-something')).toBe(false);
	});
});

describe('visibleChecklistSteps — step visibility adapts to the mode', () => {
	it('fresh-start mode hides every import / post-import step', () => {
		const ids = visibleChecklistSteps('fresh').map((s) => s.id);
		expect(ids).toEqual(['mailboxReady', 'aiConnected', 'firstSendDone']);
		expect(ids).not.toContain('importDone');
		expect(ids).not.toContain('knowledgeIndexed');
		expect(ids).not.toContain('sendingSwitched');
	});

	it('migration mode shows every step, including import + AI history', () => {
		const ids = visibleChecklistSteps('migration').map((s) => s.id);
		expect(ids).toEqual([
			'mailboxReady',
			'aiConnected',
			'importDone',
			'knowledgeIndexed',
			'sendingSwitched',
			'firstSendDone',
		]);
	});

	it('shows the universal "Connect your AI" step in both modes', () => {
		expect(visibleChecklistSteps('fresh').map((s) => s.id)).toContain(AI_CONNECTED_STEP_ID);
		expect(visibleChecklistSteps('migration').map((s) => s.id)).toContain(AI_CONNECTED_STEP_ID);
		const aiStep = CHECKLIST_STEPS.find((s) => s.id === AI_CONNECTED_STEP_ID);
		expect(aiStep?.migrationOnly).toBe(false);
		expect(aiStep?.href).toBe('/dashboard/settings/ai-provider');
	});

	it('only the migration-only steps differ between the two modes', () => {
		const migrationOnly = CHECKLIST_STEPS.filter((s) => s.migrationOnly).map((s) => s.id);
		expect(migrationOnly).toEqual(['importDone', 'knowledgeIndexed', 'sendingSwitched']);
	});
});

describe('isAiConnected — org-scoped AI step completion (env OR stored)', () => {
	// The config-gap map from `getFlagsConfigStatus` lists the `ai` flag ONLY
	// while AI is unconfigured; the backend already treats LLM_* env OR a stored
	// provider key as satisfying it. So the step's completion is purely "is the
	// `ai` key absent from the gap map?" — which must hold for BOTH sources.

	it('completes for an env-configured self-hoster (no stored row, `ai` absent from the gap)', () => {
		// LLM_* set in env ⇒ the backend drops `ai` from the gap map with no stored
		// config. This is the env-fallback path the round-1 defect missed: a working
		// env-only instance must complete the step.
		const envConfiguredGap = { campaigns: ['A configured delivery provider'] };
		expect(isAiConnected(envConfiguredGap)).toBe(true);
	});

	it('completes for a UI-configured org (stored key ⇒ `ai` absent from the gap)', () => {
		// A stored provider key likewise clears the `ai` gap; same absence, same done.
		expect(isAiConnected({})).toBe(true);
	});

	it('stays incomplete while AI is unconfigured (`ai` present in the gap)', () => {
		expect(isAiConnected({ ai: ['LLM_PROVIDER', 'LLM_API_KEY'] })).toBe(false);
	});

	it('is not complete while the config-gap query is still loading (undefined)', () => {
		// Guards against the step flashing "done" on first paint before data lands.
		expect(isAiConnected(undefined)).toBe(false);
	});
});

describe('isChecklistComplete — completeness is per visible step', () => {
	it('fresh mode completes once its universal steps are done', () => {
		const done = new Set<ChecklistStepId>(['mailboxReady', 'aiConnected', 'firstSendDone']);
		expect(isChecklistComplete('fresh', done)).toBe(true);
	});

	it('an unconnected AI step keeps a fresh checklist incomplete', () => {
		// Everything else done, but the AI provider is not yet connected.
		const done = new Set<ChecklistStepId>(['mailboxReady', 'firstSendDone']);
		expect(isChecklistComplete('fresh', done)).toBe(false);
	});

	it('the universal steps alone do NOT complete a migration checklist', () => {
		const done = new Set<ChecklistStepId>(['mailboxReady', 'aiConnected', 'firstSendDone']);
		expect(isChecklistComplete('migration', done)).toBe(false);
	});

	it('migration completes only when every step is done', () => {
		const done = new Set<ChecklistStepId>([
			'mailboxReady',
			'aiConnected',
			'importDone',
			'knowledgeIndexed',
			'sendingSwitched',
			'firstSendDone',
		]);
		expect(isChecklistComplete('migration', done)).toBe(true);
	});

	it('an empty set is never complete', () => {
		expect(isChecklistComplete('fresh', new Set())).toBe(false);
	});
});
