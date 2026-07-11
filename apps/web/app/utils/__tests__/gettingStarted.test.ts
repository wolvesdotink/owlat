import { describe, it, expect } from 'vitest';
import {
	buildGettingStarted,
	BACKUPS_STEP,
	INSTANCE_STEPS,
	type GettingStartedInput,
	type InstanceFlagId,
} from '../gettingStarted';
import { CHECKLIST_STEPS, visibleChecklistSteps, type ChecklistStepId } from '../welcomeFlow';

const NO_FLAGS: Record<InstanceFlagId, boolean> = {
	sendPathReady: false,
	addedContacts: false,
	createdEmail: false,
	sentCampaign: false,
	createdApiKey: false,
	setupDomain: false,
};

function input(overrides: Partial<GettingStartedInput> = {}): GettingStartedInput {
	return {
		role: 'member',
		isSelfHost: false,
		mode: 'fresh',
		isLoading: false,
		instanceDismissed: false,
		instanceComplete: false,
		instanceFlags: NO_FLAGS,
		showBackupsStep: false,
		userDismissed: false,
		personalCompleted: new Set<ChecklistStepId>(),
		...overrides,
	};
}

function sectionIds(model: ReturnType<typeof buildGettingStarted>): string[] {
	return model.sections.map((s) => s.id);
}

function allStepIds(model: ReturnType<typeof buildGettingStarted>): string[] {
	return model.sections.flatMap((s) => s.steps.map((step) => step.id));
}

describe('buildGettingStarted — visibility', () => {
	it('hides while loading, whatever else is true', () => {
		const model = buildGettingStarted(input({ role: 'admin', isLoading: true }));
		expect(model.visible).toBe(false);
		expect(model.dismissalScope).toBe('none');
		expect(model.sections).toEqual([]);
	});

	it('is invisible once every section is done/dismissed', () => {
		const personalCompleted = new Set(visibleChecklistSteps('fresh').map((s) => s.id));
		const model = buildGettingStarted(
			input({ role: 'admin', instanceComplete: true, personalCompleted })
		);
		expect(model.visible).toBe(false);
		expect(model.dismissalScope).toBe('none');
	});
});

describe('buildGettingStarted — viewer matrix (admin vs member)', () => {
	it('a member never sees the instance go-live section', () => {
		const model = buildGettingStarted(input({ role: 'member' }));
		expect(model.visible).toBe(true);
		expect(sectionIds(model)).toEqual(['personal']);
		expect(model.dismissalScope).toBe('user');
		expect(model.showSelfHostResources).toBe(false);
	});

	it('an admin who is also a first-time user sees ONE card with both sections', () => {
		const model = buildGettingStarted(input({ role: 'admin' }));
		expect(sectionIds(model)).toEqual(['instance', 'personal']);
		// One coherent dismissal covering both records.
		expect(model.dismissalScope).toBe('both');
	});

	it('admin with instance done but personal pending → personal only, user dismissal', () => {
		const model = buildGettingStarted(input({ role: 'admin', instanceComplete: true }));
		expect(sectionIds(model)).toEqual(['personal']);
		expect(model.dismissalScope).toBe('user');
	});

	it('admin with personal done/dismissed but instance pending → instance only', () => {
		const model = buildGettingStarted(input({ role: 'admin', userDismissed: true }));
		expect(sectionIds(model)).toEqual(['instance']);
		expect(model.dismissalScope).toBe('instance');
	});
});

describe('buildGettingStarted — mode matrix (fresh vs migration)', () => {
	it('fresh mode hides the migration-only personal steps', () => {
		const model = buildGettingStarted(input({ role: 'member', mode: 'fresh' }));
		const ids = allStepIds(model);
		expect(ids).not.toContain('importDone');
		expect(ids).not.toContain('knowledgeIndexed');
		expect(ids).not.toContain('sendingSwitched');
		expect(ids).toContain('mailboxReady');
		expect(ids).toContain('firstSendDone');
	});

	it('migration mode shows every personal step', () => {
		const model = buildGettingStarted(input({ role: 'member', mode: 'migration' }));
		const ids = allStepIds(model);
		for (const step of CHECKLIST_STEPS) {
			expect(ids).toContain(step.id);
		}
	});
});

describe('buildGettingStarted — instance steps and self-host resources', () => {
	it('carries every backend instance flag as a step, with honest completion', () => {
		const instanceFlags: Record<InstanceFlagId, boolean> = {
			...NO_FLAGS,
			sendPathReady: true,
			setupDomain: true,
		};
		const model = buildGettingStarted(input({ role: 'admin', instanceFlags }));
		const instance = model.sections.find((s) => s.id === 'instance');
		expect(instance).toBeDefined();
		const done = (instance?.steps ?? []).filter((s) => s.completed).map((s) => s.id);
		expect(done.sort()).toEqual(['sendPathReady', 'setupDomain']);
	});

	it('adds the backups step and resource links only for a self-host admin who needs them', () => {
		const model = buildGettingStarted(
			input({ role: 'admin', isSelfHost: true, showBackupsStep: true })
		);
		expect(allStepIds(model)).toContain(BACKUPS_STEP.id);
		expect(model.showSelfHostResources).toBe(true);
	});

	it('omits backups + resources off self-host', () => {
		const model = buildGettingStarted(
			input({ role: 'admin', isSelfHost: false, showBackupsStep: true })
		);
		expect(allStepIds(model)).not.toContain(BACKUPS_STEP.id);
		expect(model.showSelfHostResources).toBe(false);
	});
});

describe('buildGettingStarted — progress counts', () => {
	it('counts completed vs total across all visible steps', () => {
		const personalCompleted = new Set<ChecklistStepId>(['mailboxReady']);
		const instanceFlags: Record<InstanceFlagId, boolean> = { ...NO_FLAGS, sendPathReady: true };
		const model = buildGettingStarted(
			input({ role: 'admin', mode: 'fresh', instanceFlags, personalCompleted })
		);
		expect(model.completedCount).toBe(2);
		expect(model.totalCount).toBe(model.sections.flatMap((s) => s.steps).length);
	});
});

describe('no step present in the old three surfaces is lost', () => {
	it('every legacy step id survives in the unified catalog', () => {
		const instanceIds = INSTANCE_STEPS.map((s) => s.id);
		// The old OnboardingChecklist + self-host banner instance steps.
		expect(instanceIds.sort()).toEqual(
			[
				'addedContacts',
				'createdApiKey',
				'createdEmail',
				'sendPathReady',
				'sentCampaign',
				'setupDomain',
			].sort()
		);
		// The self-host banner's backups pointer.
		expect(BACKUPS_STEP.id).toBe('backupsScheduled');
		// The old per-user UserChecklist steps (migration shows them all).
		const personalIds = CHECKLIST_STEPS.map((s) => s.id);
		expect(personalIds.sort()).toEqual(
			[
				'aiConnected',
				'firstSendDone',
				'importDone',
				'knowledgeIndexed',
				'mailboxReady',
				'sendingSwitched',
			].sort()
		);
	});
});
