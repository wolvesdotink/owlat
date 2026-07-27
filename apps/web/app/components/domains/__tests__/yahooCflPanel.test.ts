// @vitest-environment happy-dom
/**
 * Yahoo CFL guided-enrollment panel (P4-6) — real mounts.
 *
 * The operator surface for a flow whose every decision is DERIVED by the
 * backend's pure core: the panel renders `getGuide` and never recomputes a
 * status, so these tests feed it each guide shape and assert what an operator
 * can see and do.
 *
 * D2 is the load-bearing assertion: a domain that never enrolls renders as a
 * CALM unstarted option — no error, no warning styling, no "setup incomplete"
 * nag — and states which complaint signal the yahoo cell runs on instead, with
 * the confidence caveat spelled out (D14).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, type Ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

import YahooCflPanel from '../YahooCflPanel.vue';
import {
	yahooCflGuidedSteps,
	yahooComplaintSubstitution,
	YAHOO_CFL_ENROLLMENT_URL,
	YAHOO_CFL_LAPSE_SILENCE_MS,
	type YahooCflDkimPrecondition,
	type YahooCflEnrollmentRecord,
	type YahooCflEnrollmentState,
} from '@owlat/shared/yahooCfl';

const PRECONDITION: YahooCflDkimPrecondition = {
	domain: 'mail.example.com',
	isVerified: true,
	dkimSelector: 's1711234567',
};

const T0 = Date.UTC(2026, 6, 1);

/**
 * Build the guide EXACTLY as the backend does — same pure functions — so the
 * fixtures cannot drift from the query's real shape.
 */
function guideFor(
	record: YahooCflEnrollmentRecord,
	state: YahooCflEnrollmentState,
	precondition: YahooCflDkimPrecondition = PRECONDITION,
	nowMs = T0
) {
	return {
		domain: precondition.domain,
		state,
		silentMs: 0,
		enrollment: record,
		precondition,
		steps: yahooCflGuidedSteps(record, precondition, nowMs),
		complaintSignal: yahooComplaintSubstitution({
			enrollmentState: state,
			hasCfblAddress: false,
		}),
	};
}

const NOT_STARTED = guideFor({ state: 'not_started' }, 'not_started');
const AWAITING = guideFor({ state: 'awaiting_yahoo', submittedAt: T0 }, 'awaiting_yahoo');
const ENROLLED = guideFor({ state: 'enrolled', enrolledAt: T0, lastReportAt: T0 }, 'enrolled');
// The derived lapse is a function of the clock, so the fixture's steps must be
// built at a clock that actually produces it — otherwise the panel would render
// `enrolled` steps under a `lapsed` badge.
const LAPSED = guideFor(
	{ state: 'enrolled', enrolledAt: T0, lastReportAt: T0 },
	'lapsed',
	PRECONDITION,
	T0 + YAHOO_CFL_LAPSE_SILENCE_MS
);

let queryArgs: unknown;
let runs: Record<string, ReturnType<typeof vi.fn>>;

function stubBackend(guide: unknown) {
	const data = ref(guide);
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: unknown) => {
		queryArgs = typeof args === 'function' ? (args as () => unknown)() : args;
		return { data, isLoading: ref(false) };
	});
	runs = {
		submitEnrollment: vi.fn(async () => null),
		confirmEnrollment: vi.fn(async () => null),
		resetEnrollment: vi.fn(async () => null),
	};
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: string }) => {
		// The operation label is the only handle on WHICH mutation was bound, since
		// the api object is stubbed out of this environment.
		const key = opts.label.includes('submission')
			? 'submitEnrollment'
			: opts.label.includes('Confirm')
				? 'confirmEnrollment'
				: 'resetEnrollment';
		return { run: runs[key], isLoading: ref(false) as Ref<boolean> };
	});
}

function mountPanel(guide: unknown, canManage = true) {
	stubBackend(guide);
	return mount(YahooCflPanel, {
		props: { domainId: 'domain_1', canManage },
		global: { stubs: { Icon: { props: ['name'], template: '<i :data-icon="name" />' } } },
	});
}

// "Start over" names its consequence in a confirmation before it fires, so every
// fixture has to decide what the operator answered.
const confirmSpy = vi.fn((_message?: string) => true);

beforeEach(() => {
	queryArgs = undefined;
	confirmSpy.mockClear();
	confirmSpy.mockReturnValue(true);
	vi.stubGlobal('confirm', confirmSpy);
	window.confirm = confirmSpy;
});

describe('the four guided steps', () => {
	it('renders all four steps with their action and their "how to tell it worked"', () => {
		const w = mountPanel(NOT_STARTED);
		const steps = w.findAll('[data-testid^="yahoocfl-step-"]');
		expect(steps).toHaveLength(4);
		for (const step of steps) {
			expect(step.text()).toContain('How to tell it worked');
		}
		expect(w.get('[data-testid="yahoocfl-step-submit_enrollment"]').text()).toContain(
			"Yahoo's Complaint Feedback Loop"
		);
	});

	it('renders the blocked status without dressing it as an error', () => {
		// Nothing submitted yet, so steps 3 and 4 are simply not the operator's turn.
		const w = mountPanel(NOT_STARTED);
		const confirm = w.get('[data-testid="yahoocfl-step-confirm_enrollment"]');
		expect(confirm.attributes('data-status')).toBe('blocked');
		expect(confirm.html()).not.toContain('text-error');
		expect(confirm.html()).not.toContain('alert-triangle');
	});

	it('marks the earlier steps done and the current one in_progress once submitted', () => {
		const w = mountPanel(AWAITING);
		const statuses = w
			.findAll('[data-testid^="yahoocfl-step-"]')
			.map((s) => s.attributes('data-status'));
		expect(statuses).toEqual(['done', 'done', 'in_progress', 'blocked']);
	});

	it('links out to Yahoo enrollment form on the step that needs it', () => {
		const w = mountPanel(NOT_STARTED);
		const link = w.get('[data-testid="yahoocfl-link-submit_enrollment"]');
		expect(link.attributes('href')).toBe(YAHOO_CFL_ENROLLMENT_URL);
		expect(link.attributes('rel')).toContain('noopener');
	});
});

describe('the state banner', () => {
	it.each([
		[NOT_STARTED, 'Not enrolled'],
		[AWAITING, 'Waiting for Yahoo'],
		[ENROLLED, 'Enrolled'],
		[LAPSED, 'Worth re-checking'],
	])('names each of the four states plainly', (guide, label) => {
		expect(mountPanel(guide).get('[data-testid="yahoocfl-state"]').text()).toBe(label);
	});

	it('never styles not_started or lapsed as an error', () => {
		for (const guide of [NOT_STARTED, LAPSED]) {
			const badge = mountPanel(guide).get('[data-testid="yahoocfl-state"]');
			expect(badge.classes().join(' ')).not.toContain('error');
			expect(badge.classes().join(' ')).not.toContain('warning');
		}
	});
});

describe('the controls', () => {
	it('records the submission and calls the mutation with the domain id', async () => {
		const w = mountPanel(NOT_STARTED);
		await w.get('[data-testid="yahoocfl-submit"]').trigger('click');
		await flushPromises();
		expect(runs['submitEnrollment']).toHaveBeenCalledWith({ domainId: 'domain_1' });
	});

	it('offers Confirm only while Yahoo has not acknowledged', async () => {
		const notStarted = mountPanel(NOT_STARTED);
		expect(notStarted.find('[data-testid="yahoocfl-confirm"]').exists()).toBe(false);

		const w = mountPanel(AWAITING);
		await w.get('[data-testid="yahoocfl-confirm"]').trigger('click');
		await flushPromises();
		expect(runs['confirmEnrollment']).toHaveBeenCalledWith({ domainId: 'domain_1' });
	});

	it('offers Start over once something has been recorded, and re-submit when lapsed', async () => {
		expect(mountPanel(NOT_STARTED).find('[data-testid="yahoocfl-reset"]').exists()).toBe(false);
		const w = mountPanel(LAPSED);
		// A lapsed enrollment is re-submittable AND resettable — both are to-dos.
		expect(w.find('[data-testid="yahoocfl-submit"]').exists()).toBe(true);
		await w.get('[data-testid="yahoocfl-reset"]').trigger('click');
		expect(confirmSpy).toHaveBeenCalledTimes(1);
		await flushPromises();
		expect(runs['resetEnrollment']).toHaveBeenCalledWith({ domainId: 'domain_1' });
	});

	it('disables Submit until the DKIM domain is verified and signing', () => {
		const w = mountPanel(
			guideFor({ state: 'not_started' }, 'not_started', {
				domain: 'mail.example.com',
				isVerified: false,
			})
		);
		const submit = w.get('[data-testid="yahoocfl-submit"]');
		expect(submit.attributes('disabled')).toBeDefined();
		// The disabled state is read off the guide's own `blocked` step, not
		// recomputed here: the panel has exactly one definition of the precondition.
		expect(w.get('[data-testid="yahoocfl-step-submit_enrollment"]').attributes('data-status')).toBe(
			'blocked'
		);
	});

	it('states the reason Submit is disabled as VISIBLE, described text', () => {
		const w = mountPanel(
			guideFor({ state: 'not_started' }, 'not_started', {
				domain: 'mail.example.com',
				isVerified: false,
			})
		);
		// A `title` on a disabled button is neither focusable nor announced, so the
		// reason is real text the button points at.
		const hint = w.get('[data-testid="yahoocfl-submit-blocked-reason"]');
		expect(hint.text()).toContain('Verify this domain and its DKIM record first');
		expect(w.get('[data-testid="yahoocfl-submit"]').attributes('aria-describedby')).toBe(
			hint.attributes('id')
		);
	});

	it('hides the blocked reason once the precondition is met', () => {
		const w = mountPanel(NOT_STARTED);
		expect(w.find('[data-testid="yahoocfl-submit-blocked-reason"]').exists()).toBe(false);
		expect(w.get('[data-testid="yahoocfl-submit"]').attributes('disabled')).toBeUndefined();
	});

	it('does NOT reset unless the operator confirms, and names the consequence when asking', async () => {
		confirmSpy.mockReturnValue(false);
		const w = mountPanel(ENROLLED);
		await w.get('[data-testid="yahoocfl-reset"]').trigger('click');
		await flushPromises();
		expect(runs['resetEnrollment']).not.toHaveBeenCalled();
		const asked = String(confirmSpy.mock.calls[0]?.[0] ?? '');
		// All three consequences are named: our record, Yahoo's own enrollment, and
		// what happens to complaint measurement afterwards.
		expect(asked).toContain('Our record is cleared');
		expect(asked).toContain('Yahoo’s own enrollment is untouched');
		expect(asked).toContain('unsubscribe-rate proxy');
	});

	it('shows no controls, and does not subscribe, for a member who cannot manage domains', () => {
		const w = mountPanel(NOT_STARTED, false);
		expect(w.find('[data-testid="yahoocfl-submit"]').exists()).toBe(false);
		expect(w.find('[data-testid="yahoocfl-reset"]').exists()).toBe(false);
		// The backend query is admin-gated, so a non-admin must skip it entirely
		// rather than surface a `forbidden` rejection on the domain row.
		expect(queryArgs).toBe('skip');
	});
});

describe('D2 — never enrolling is a supported configuration', () => {
	it('states the substituted signal and its caveat instead of a nag', () => {
		const w = mountPanel(NOT_STARTED);
		const confidence = w.get('[data-testid="yahoocfl-confidence"]').text();
		expect(confidence).toContain('Measurement confidence: low');
		expect(confidence).toContain('unsubscribes stand in for complaints');
		// No nag, no error, no "incomplete" framing anywhere on the panel.
		const text = w.text().toLowerCase();
		expect(text).not.toContain('incomplete');
		expect(text).not.toContain('required');
		expect(text).not.toContain('error');
		expect(w.text()).toContain('Enrolling is optional');
	});

	it('reports full confidence once enrolled', () => {
		const w = mountPanel(ENROLLED);
		expect(w.get('[data-testid="yahoocfl-confidence"]').text()).toContain(
			'Measurement confidence: high'
		);
	});

	it('renders nothing at all rather than a placeholder while the guide is absent', () => {
		const w = mountPanel(undefined);
		expect(w.find('[data-testid="yahoocfl-panel"]').exists()).toBe(false);
		// Not even the section divider: an empty bordered strip is exactly what a
		// member without `organization:manage`, the first paint, and a deleted domain
		// would otherwise all render.
		expect(w.html()).not.toContain('border-t');
	});

	it('owns its section divider so the divider follows the panel', () => {
		expect(mountPanel(NOT_STARTED).get('[data-testid="yahoocfl-panel"]').classes()).toContain(
			'border-t'
		);
	});
});
