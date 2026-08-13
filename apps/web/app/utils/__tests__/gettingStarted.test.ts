import { describe, it, expect } from 'vitest';
import {
	buildGettingStarted,
	BACKUPS_STEP,
	INSTANCE_STEPS,
	READY_TO_SEND_STEP,
	SEND_BLOCKED_REASON,
	SEND_BLOCKED_STEP_IDS,
	sentCampaignDescription,
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
		// Default to a sendable instance; the blocked-step cases opt out explicitly.
		sendPathReady: true,
		// Default to "no cap to quote"; the readiness cases supply one.
		sendCapacityToday: null,
		...overrides,
	};
}

function personalStep(model: ReturnType<typeof buildGettingStarted>, id: ChecklistStepId) {
	return model.sections.find((s) => s.id === 'personal')?.steps.find((step) => step.id === id);
}

function sectionIds(model: ReturnType<typeof buildGettingStarted>): string[] {
	return model.sections.map((s) => s.id);
}

function allStepIds(model: ReturnType<typeof buildGettingStarted>): string[] {
	return model.sections.flatMap((s) => s.steps.map((step) => step.id));
}

function readyStep(model: ReturnType<typeof buildGettingStarted>) {
	return model.sections
		.find((s) => s.id === 'instance')
		?.steps.find((step) => step.id === 'readyToSend');
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
	it('leads the instance section with the one readiness step, deferring both pre-send halves', () => {
		const model = buildGettingStarted(input({ role: 'admin' }));
		const instance = model.sections.find((s) => s.id === 'instance');
		expect(instance).toBeDefined();
		const steps = instance?.steps ?? [];
		// The single "Get ready to send" step leads and points at the Delivery hub.
		expect(steps[0]?.id).toBe('readyToSend');
		expect(steps[0]?.href).toBe('/dashboard/admin/delivery');
		// The two go-live halves are NOT re-listed as separate steps here.
		const ids = steps.map((s) => s.id);
		expect(ids).not.toContain('sendPathReady');
		expect(ids).not.toContain('setupDomain');
		// Nor do their old standalone destinations reappear anywhere on the surface.
		const hrefs = steps.map((s) => s.href);
		expect(hrefs).not.toContain('/dashboard/admin/delivery/transport');
		expect(hrefs).not.toContain('/dashboard/admin/delivery/domains');
	});

	it('marks the readiness step done only when transport AND a verified domain are both in place', () => {
		const bothOff = buildGettingStarted(input({ role: 'admin' }));
		expect(readyStep(bothOff)?.completed).toBe(false);

		const transportOnly = buildGettingStarted(
			input({ role: 'admin', instanceFlags: { ...NO_FLAGS, sendPathReady: true } })
		);
		expect(readyStep(transportOnly)?.completed).toBe(false);

		const domainOnly = buildGettingStarted(
			input({ role: 'admin', instanceFlags: { ...NO_FLAGS, setupDomain: true } })
		);
		expect(readyStep(domainOnly)?.completed).toBe(false);

		const both = buildGettingStarted(
			input({
				role: 'admin',
				instanceFlags: { ...NO_FLAGS, sendPathReady: true, setupDomain: true },
			})
		);
		expect(readyStep(both)?.completed).toBe(true);
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
		// Both go-live halves done → the folded readiness step counts once.
		const instanceFlags: Record<InstanceFlagId, boolean> = {
			...NO_FLAGS,
			sendPathReady: true,
			setupDomain: true,
		};
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
		// The old OnboardingChecklist instance steps, minus the two pre-send halves.
		expect(instanceIds.sort()).toEqual(
			['addedContacts', 'createdApiKey', 'createdEmail', 'sentCampaign'].sort()
		);
		// The two go-live halves (sendPathReady + setupDomain) are not dropped — they
		// are subsumed by the one readiness step that defers to the Delivery hub.
		expect(READY_TO_SEND_STEP.id).toBe('readyToSend');
		expect(READY_TO_SEND_STEP.href).toBe('/dashboard/admin/delivery');
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

describe('the send steps block and unblock with the instance transport', () => {
	it('marks the first-send step blocked while the instance cannot send', () => {
		const model = buildGettingStarted(input({ sendPathReady: false }));
		const step = personalStep(model, 'firstSendDone');
		expect(step?.blocked).toBe(true);
		expect(step?.blockedReason).toBe(SEND_BLOCKED_REASON);
		// Blocked is not done: the step still counts as outstanding work.
		expect(step?.completed).toBe(false);
		expect(model.completedCount).toBe(0);
	});

	it('blocks the migration sending switch too, and nothing else', () => {
		const model = buildGettingStarted(input({ mode: 'migration', sendPathReady: false }));
		const blocked = model.sections
			.flatMap((s) => s.steps)
			.filter((step) => step.blocked)
			.map((step) => step.id);
		expect(blocked.sort()).toEqual([...SEND_BLOCKED_STEP_IDS].sort());
	});

	it('unblocks every send step the moment the transport is ready', () => {
		const model = buildGettingStarted(input({ mode: 'migration', sendPathReady: true }));
		expect(model.sections.flatMap((s) => s.steps).some((step) => step.blocked)).toBe(false);
		expect(personalStep(model, 'firstSendDone')?.blockedReason).toBeUndefined();
	});

	it('never blocks a step the member already completed', () => {
		const model = buildGettingStarted(
			input({
				sendPathReady: false,
				personalCompleted: new Set<ChecklistStepId>(['firstSendDone']),
			})
		);
		const step = personalStep(model, 'firstSendDone');
		expect(step?.completed).toBe(true);
		expect(step?.blocked).toBeUndefined();
	});
});

describe("the send-a-campaign step carries today's sending headroom", () => {
	function campaignStep(model: ReturnType<typeof buildGettingStarted>) {
		return model.sections
			.find((s) => s.id === 'instance')
			?.steps.find((step) => step.id === 'sentCampaign');
	}

	it('quotes the measured capacity so the ramp is met before a campaign is built', () => {
		const model = buildGettingStarted(input({ role: 'admin', sendCapacityToday: 1200 }));
		expect(campaignStep(model)?.description).toContain('About 1,200 contacts can be reached today');
	});

	it('says the day is spent rather than quoting "about 0 contacts"', () => {
		const model = buildGettingStarted(input({ role: 'admin', sendCapacityToday: 0 }));
		const description = campaignStep(model)?.description ?? '';
		expect(description).toContain('used up');
		expect(description).not.toContain('About 0');
		// Never a dead end: scheduling is still the thing to do.
		expect(description).toContain('schedule');
	});

	it('invents nothing when capacity is unmeasured or uncapped', () => {
		const model = buildGettingStarted(input({ role: 'admin', sendCapacityToday: null }));
		expect(campaignStep(model)?.description).toBe(
			'Send your first email campaign to your audience.'
		);
	});

	it('leaves every other instance step untouched', () => {
		const model = buildGettingStarted(input({ role: 'admin', sendCapacityToday: 500 }));
		const others = model.sections
			.find((s) => s.id === 'instance')
			?.steps.filter((step) => step.id !== 'sentCampaign');
		expect(others?.some((step) => step.description.includes('500'))).toBe(false);
	});

	it('is pure: the same input always yields the same sentence', () => {
		expect(sentCampaignDescription(null)).toBe('Send your first email campaign to your audience.');
		expect(sentCampaignDescription(1)).toContain('About 1 contact can be reached today');
	});
});
