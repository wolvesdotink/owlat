/**
 * The body of `GET /api/v1/status`: whether this instance can send, and if
 * not, why and what fixes it. Plain TypeScript with no imports, re-exported by
 * `types.ts`; see there for why.
 */

/**
 * How sending stands overall: `error` is a serious problem that affects or
 * threatens delivery, `warn` needs attention. Whether sending is suspended now
 * is `sendingHold`.
 */
export const DELIVERY_STATUS_LEVELS = ['ok', 'warn', 'error'] as const;

/** How sending stands overall. */
export type DeliveryStatusLevel = (typeof DELIVERY_STATUS_LEVELS)[number];

/**
 * The worst problem the status names, as a stable code. The server's tests
 * hold this list equal to the delivery-health roll-up's own. New codes can be
 * added; treat an unknown one by its `level`.
 */
export const DELIVERY_STATUS_REASONS = [
	'healthy',
	'sending_suspended',
	'sending_banned',
	'no_provider',
	'no_provider_transactional',
	'no_provider_campaign',
	'feedback_missing_campaign',
	'feedback_missing_transactional',
	'mta_signing_held',
	'mta_signing_held_unnamed',
	'mta_degraded',
	'mta_unreachable',
	'mta_stale',
	'mta_unchecked',
	'ips_all_held',
	'ips_some_held',
	'domain_failed',
	'no_domain',
	'no_verified_domain',
	'domain_pending',
	'sender_missing',
	'sender_unverified',
	'warmup_halted',
	'reputation_critical',
	'reputation_high',
	'reputation_medium',
] as const;

/** The worst problem the status names. */
export type DeliveryStatusReason = (typeof DELIVERY_STATUS_REASONS)[number];

/**
 * Who can make a fix: an admin of the workspace, a platform admin of the
 * instance, a member who manages contacts, or whoever runs the deployment and
 * sets its environment.
 */
export const DELIVERY_FIX_AUDIENCES = [
	'workspace_admin',
	'platform_admin',
	'contact_manager',
	'deployment_operator',
] as const;

/** Who can make a fix. */
export type DeliveryFixAudience = (typeof DELIVERY_FIX_AUDIENCES)[number];

/** Where the fix for a reason is made. */
export interface DeliveryFix {
	/** Path of the page in the instance's web app, for example `/dashboard/admin/delivery/domains`. */
	route: string;
	/** Who can make the fix there. */
	who: DeliveryFixAudience;
}

/** Verification states of a sending domain. Only `verified` can send. */
export const SENDING_DOMAIN_STATUSES = ['registering', 'pending', 'verified', 'failed'] as const;

/** Verification state of a sending domain. */
export type SendingDomainStatusValue = (typeof SENDING_DOMAIN_STATUSES)[number];

/** One sending domain and where its verification stands. */
export interface SendingDomain {
	domain: string;
	status: SendingDomainStatusValue;
}

/** A rate over the window, against the limit past which it counts against sending. */
export interface RateAgainstLimit {
	/** The rate in percent, to three decimals. */
	ratePct: number;
	/** The limit in percent. */
	limitPct: number;
	/** Whether the rate has reached the limit. */
	isOver: boolean;
}

/** The instance's bounce and complaint rates over a rolling window. */
export interface DeliveryRates {
	/** Length of the rolling window, in days. */
	windowDays: number;
	/** Emails sent in the window. */
	sent: number;
	bounce: RateAgainstLimit;
	complaint: RateAgainstLimit;
}

/**
 * How a suspension lifts: `automatic` lifts by itself once `condition` is
 * met; `manual_setting` waits for a platform admin, even after the rates
 * recover, because the instance is set to; `admin` never lifts by itself (a
 * ban, or a suspension a platform admin imposed). A platform admin can lift
 * any of them in the operator console.
 */
export const SENDING_HOLD_LIFT_MODES = ['automatic', 'manual_setting', 'admin'] as const;

/** How a suspension lifts. */
export type SendingHoldLiftMode = (typeof SENDING_HOLD_LIFT_MODES)[number];

/**
 * The metric a suspension the reputation check imposed waits on: the 30-day
 * bounce or complaint rate, or Gmail's spam rate for one sending domain.
 */
export const SENDING_HOLD_TRIGGERS = ['bounce_rate', 'complaint_rate', 'gmail_spam_rate'] as const;

/** The metric an automatic lift waits on. */
export type SendingHoldTrigger = (typeof SENDING_HOLD_TRIGGERS)[number];

/** What has to be true for an automatic lift, and where it stands. */
export interface SendingHoldLiftCondition {
	trigger: SendingHoldTrigger;
	/** The sending domain of a Gmail spam rate; `null` for the instance-wide rates. */
	domain: string | null;
	/**
	 * The metric now, in percent: the 30-day rate, or the highest Gmail reading
	 * at or above the limit. `null` when no evidence is left in the window.
	 */
	currentPct: number | null;
	/** Sending resumes once the metric is under this, in percent. */
	limitPct: number;
	/** The metric is back under the limit: sending resumes at the next hourly check. */
	isClear: boolean;
	/** ISO 8601 time the last Gmail reading over the limit leaves the 30-day window; `null` otherwise. */
	clearsAt: string | null;
}

/** How a suspension lifts, and on what condition when it lifts by itself. */
export interface SendingHoldLift {
	mode: SendingHoldLiftMode;
	/** Set when `mode` is `automatic`, otherwise `null`. */
	condition: SendingHoldLiftCondition | null;
}

/**
 * Sending is suspended or banned: every new send is refused. The same fields
 * the `403 abuse_blocked` refusal of `POST /api/v1/transactional` carries.
 */
export interface SendingHold {
	status: 'suspended' | 'banned';
	/** ISO 8601 timestamp of when the status was set; `null` if it was not recorded. */
	since: string | null;
	/** The reason recorded with the status, or `null` when none was. */
	detail: string | null;
	/** How it lifts. */
	lift: SendingHoldLift;
}

/** Body of `GET /api/v1/status`. */
export interface DeliveryStatus {
	level: DeliveryStatusLevel;
	reasonCode: DeliveryStatusReason;
	/** What the reason means and what to do about it, in English. */
	explanation: string;
	/** Where the fix is made; `null` when there is nothing to fix. */
	fix: DeliveryFix | null;
	/** Every sending domain with its verification state. */
	domains: SendingDomain[];
	/** The rolling rates; `null` while the window holds no sends, deliveries, bounces or complaints. */
	rates: DeliveryRates | null;
	/** The suspension or ban in force; `null` while sending is allowed. */
	sendingHold: SendingHold | null;
}
