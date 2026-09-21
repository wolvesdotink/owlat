/**
 * Presentation helpers for the platform-admin Operator Console.
 *
 * Pure mapping functions kept out of the page component so the badge/label
 * logic is unit-testable without mounting Nuxt. The backend lives in
 * `apps/api/convex/platformAdmin/` and is `requirePlatformAdmin`-gated; this
 * module only decides how its values are rendered.
 */

import { formatPercentage } from '~/utils/formatters';

/** UiBadge variant for an org abuse status. */
export function abuseStatusVariant(
	status: string | undefined
): 'success' | 'warning' | 'error' | 'neutral' {
	switch (status) {
		case 'clean':
			return 'success';
		case 'warned':
			return 'warning';
		case 'suspended':
		case 'banned':
			return 'error';
		default:
			return 'neutral';
	}
}

/**
 * True when an abuse status hard-blocks all sending and needs operator action.
 *
 * Mirrors the backend gate `organizations/abuseGate.ts → isSendingAllowed`
 * (negated): only `suspended` and `banned` stop sending. `warned` is the soft
 * auto-warn state (`sendingReputation.ts` high → warned) and does NOT block.
 */
export function isBlockingAbuseStatus(status: string | undefined): boolean {
	return status === 'suspended' || status === 'banned';
}

/** UiBadge variant for a reputation risk level. */
export function riskLevelVariant(
	level: string | undefined
): 'success' | 'warning' | 'error' | 'neutral' {
	switch (level) {
		case 'low':
			return 'success';
		case 'medium':
			return 'warning';
		case 'high':
		case 'critical':
			return 'error';
		default:
			return 'neutral';
	}
}

/** UiBadge variant for a content-scan level. */
export function scanLevelVariant(
	level: string | undefined
): 'success' | 'warning' | 'error' | 'neutral' {
	switch (level) {
		case 'safe':
			return 'success';
		case 'suspicious':
			return 'warning';
		case 'blocked':
			return 'error';
		default:
			return 'neutral';
	}
}

/** Format a 0–1 rate as a percentage string (e.g. 0.0123 → "1.23%"). */
export function formatRate(rate: number | undefined): string {
	if (rate === undefined || Number.isNaN(rate)) return '—';
	return formatPercentage(rate, 2, true);
}

/**
 * The catalog key that words a platform-admin audit action. This module is
 * mapping-only and never calls `useI18n`; the console renders the key through
 * `t()`. An action with no copy of its own falls back to the raw action name,
 * exactly as it did before — an unrecognised identifier is still better than a
 * blank cell.
 */
export function auditActionLabel(action: string | undefined): string {
	switch (action) {
		case 'platform_admin.content_approved':
			return 'shared.operatorConsole.auditAction.contentApproved';
		case 'platform_admin.content_rejected':
			return 'shared.operatorConsole.auditAction.contentRejected';
		case 'platform_admin.org_status_changed':
			return 'shared.operatorConsole.auditAction.orgStatusChanged';
		case 'platform_admin.admin_added':
			return 'shared.operatorConsole.auditAction.adminAdded';
		case 'platform_admin.admin_removed':
			return 'shared.operatorConsole.auditAction.adminRemoved';
		default:
			return action ?? 'shared.operatorConsole.auditAction.unknown';
	}
}
