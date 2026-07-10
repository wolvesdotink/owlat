import { describe, it, expect } from 'vitest';
import {
	CHECKLIST_STEPS,
	isChecklistComplete,
	isWelcomeTriggerPath,
	shouldRouteToWelcome,
	shouldShowUserChecklist,
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
		expect(ids).toEqual(['mailboxReady', 'firstSendDone']);
		expect(ids).not.toContain('importDone');
		expect(ids).not.toContain('knowledgeIndexed');
		expect(ids).not.toContain('sendingSwitched');
	});

	it('migration mode shows every step, including import + AI history', () => {
		const ids = visibleChecklistSteps('migration').map((s) => s.id);
		expect(ids).toEqual([
			'mailboxReady',
			'importDone',
			'knowledgeIndexed',
			'sendingSwitched',
			'firstSendDone',
		]);
	});

	it('only the migration-only steps differ between the two modes', () => {
		const migrationOnly = CHECKLIST_STEPS.filter((s) => s.migrationOnly).map((s) => s.id);
		expect(migrationOnly).toEqual(['importDone', 'knowledgeIndexed', 'sendingSwitched']);
	});
});

describe('isChecklistComplete — completeness is per visible step', () => {
	it('fresh mode completes once its two universal steps are done', () => {
		const done = new Set<ChecklistStepId>(['mailboxReady', 'firstSendDone']);
		expect(isChecklistComplete('fresh', done)).toBe(true);
	});

	it('the same two steps do NOT complete a migration checklist', () => {
		const done = new Set<ChecklistStepId>(['mailboxReady', 'firstSendDone']);
		expect(isChecklistComplete('migration', done)).toBe(false);
	});

	it('migration completes only when every step is done', () => {
		const done = new Set<ChecklistStepId>([
			'mailboxReady',
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

describe('shouldShowUserChecklist — visibility gating', () => {
	const base = { isLoading: false, dismissed: false, isComplete: false };

	it('shows when loaded, not dismissed, and incomplete', () => {
		expect(shouldShowUserChecklist(base)).toBe(true);
	});

	it('hides while loading', () => {
		expect(shouldShowUserChecklist({ ...base, isLoading: true })).toBe(false);
	});

	it('hides once dismissed', () => {
		expect(shouldShowUserChecklist({ ...base, dismissed: true })).toBe(false);
	});

	it('hides for good once complete', () => {
		expect(shouldShowUserChecklist({ ...base, isComplete: true })).toBe(false);
	});
});
