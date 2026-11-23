/**
 * Why a failed automation run failed, or what a waiting one waits for, and
 * where that is fixed.
 *
 * The backend codes every step failure from a closed set
 * (`automationStepFailureReasonValidator`). Its three send-gate codes are the
 * campaign pre-flight's codes for the same gate, so their fix pages come from
 * the campaign refusal map and a fault is fixed on one page whichever send hit
 * it. The automation's own codes add the two pages no campaign refusal names.
 *
 * Module scope, so no `useI18n` here: the note component resolves the keys.
 */
import type { Doc } from '@owlat/api/dataModel';
import type { PreflightFailureReason } from '@owlat/api/campaignRefusal';
import { refusalFixLink, type RefusalFixLink } from '~/lib/campaignRefusal';

export type AutomationStepFailureReason = NonNullable<Doc<'automationStepRuns'>['failureReason']>;

/** The codes the automation shares with the campaign pre-flight. */
type SharedGateReason = AutomationStepFailureReason & PreflightFailureReason;

const sharedFix = (reason: SharedGateReason): RefusalFixLink | null => refusalFixLink(reason);

/** Fixed in the automation's own editor, which needs `automations:manage` (admins). */
const IN_AUTOMATION = 'automation';

const FAILURE_FIX_LINKS: Readonly<
	Record<AutomationStepFailureReason, RefusalFixLink | typeof IN_AUTOMATION | null>
> = {
	no_delivery_provider: sharedFix('no_delivery_provider'),
	domain_not_verified: sharedFix('domain_not_verified'),
	sending_not_allowed: sharedFix('sending_not_allowed'),
	// Automation mail goes out from the instance default sender, set there.
	no_default_sender: {
		to: '/dashboard/admin/instance/general',
		labelKey: 'dashboard.automations.detail.index.runs.failure.fix.defaultSender',
	},
	plugin_denied: {
		to: '/dashboard/admin/instance/plugins',
		labelKey: 'dashboard.automations.detail.index.runs.failure.fix.plugins',
	},
	template_missing: IN_AUTOMATION,
	template_empty: IN_AUTOMATION,
	invalid_step_config: IN_AUTOMATION,
	step_limit: IN_AUTOMATION,
	// Not fixable from a page.
	contact_no_email: null,
	plugin_failed: null,
	interrupted: null,
	unknown: null,
};

const MESSAGE_KEYS: Readonly<Record<AutomationStepFailureReason, string>> = {
	no_delivery_provider: 'dashboard.automations.detail.index.runs.failure.noDeliveryProvider',
	domain_not_verified: 'dashboard.automations.detail.index.runs.failure.domainNotVerified',
	sending_not_allowed: 'dashboard.automations.detail.index.runs.failure.sendingNotAllowed',
	no_default_sender: 'dashboard.automations.detail.index.runs.failure.noDefaultSender',
	template_missing: 'dashboard.automations.detail.index.runs.failure.templateMissing',
	template_empty: 'dashboard.automations.detail.index.runs.failure.templateEmpty',
	contact_no_email: 'dashboard.automations.detail.index.runs.failure.contactNoEmail',
	invalid_step_config: 'dashboard.automations.detail.index.runs.failure.invalidStepConfig',
	plugin_denied: 'dashboard.automations.detail.index.runs.failure.pluginDenied',
	plugin_failed: 'dashboard.automations.detail.index.runs.failure.pluginFailed',
	interrupted: 'dashboard.automations.detail.index.runs.failure.interrupted',
	step_limit: 'dashboard.automations.detail.index.runs.failure.stepLimit',
	unknown: 'dashboard.automations.detail.index.runs.failure.unknown',
};

/**
 * An email step that hits one of these waits for the fix instead of failing
 * (`automations/configurationWait.ts`); each sentence takes the give-up `{date}`.
 */
const WAITING_MESSAGE_KEYS: Readonly<Partial<Record<AutomationStepFailureReason, string>>> = {
	no_delivery_provider: 'dashboard.automations.detail.index.runs.waiting.noDeliveryProvider',
	domain_not_verified: 'dashboard.automations.detail.index.runs.waiting.domainNotVerified',
	sending_not_allowed: 'dashboard.automations.detail.index.runs.waiting.sendingNotAllowed',
	no_default_sender: 'dashboard.automations.detail.index.runs.waiting.noDefaultSender',
	// A wait reason this build does not know (the backend is newer).
	unknown: 'dashboard.automations.detail.index.runs.waiting.unknown',
};

/**
 * A run's failure as `getAutomationRuns` returns it, or its wait (which also
 * carries `until`, when the wait gives up).
 */
export interface AutomationRunFailure {
	reason: string;
	detail: string | null;
	until?: number;
}

export interface RunFailureNote {
	messageKey: string;
	fix: RefusalFixLink | null;
	/** The stored sentence, shown one click away. */
	detail: string | null;
}

const isKnownReason = (reason: string): reason is AutomationStepFailureReason =>
	Object.hasOwn(MESSAGE_KEYS, reason);

/**
 * The note for a failure of a run of `automationId`. A code this build does not
 * know reads as `unknown`, so the stored sentence still shows: the desktop app
 * ships the web build and can be older than the backend it talks to.
 */
export function runFailureNote(
	failure: AutomationRunFailure,
	automationId: string
): RunFailureNote {
	const reason = isKnownReason(failure.reason) ? failure.reason : 'unknown';
	const fix = FAILURE_FIX_LINKS[reason];
	const waitingKey =
		failure.until === undefined
			? undefined
			: (WAITING_MESSAGE_KEYS[reason] ?? WAITING_MESSAGE_KEYS.unknown);
	return {
		messageKey: waitingKey ?? MESSAGE_KEYS[reason],
		fix:
			fix === IN_AUTOMATION
				? {
						to: `/dashboard/automations/${automationId}/edit`,
						labelKey: 'dashboard.automations.detail.index.editAutomation',
					}
				: fix,
		detail: failure.detail,
	};
}

/** Every catalog key a failure note can name, for the locale coverage check. */
export function allRunFailureMessageKeys(): string[] {
	const fixKeys = Object.values(FAILURE_FIX_LINKS).flatMap((fix) =>
		fix === IN_AUTOMATION
			? ['dashboard.automations.detail.index.editAutomation']
			: fix
				? [fix.labelKey, ...(fix.askKey ? [fix.askKey] : [])]
				: []
	);
	return [...Object.values(MESSAGE_KEYS), ...Object.values(WAITING_MESSAGE_KEYS), ...fixKeys];
}
