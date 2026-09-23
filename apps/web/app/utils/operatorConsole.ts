/**
 * Presentation helpers for the platform-admin Operator Console.
 *
 * Pure mapping functions kept out of the page component so the badge/label
 * logic is unit-testable without mounting Nuxt. The backend lives in
 * `apps/api/convex/platformAdmin/` and is `requirePlatformAdmin`-gated; this
 * module only decides how its values are rendered.
 */

import { formatPercentage } from '~/utils/formatters';

/**
 * Whether the Operator Console has anything to offer on this deployment.
 *
 * Its tabs — content review across tenants, the workspace list, the platform
 * admin roster — are hosted multi-tenant tooling. A self-hosted instance with
 * one workspace sees three empty tabs and an overview that repeats Delivery →
 * Health, so there the console is hidden, unless the instance really does
 * hold more than one workspace.
 *
 * `pending` while the workspace count is unknown on a self-hosted instance, so
 * the page neither flashes the console nor redirects on a guess. If the count
 * cannot be read at all the console shows (its tabs report their own errors)
 * instead of waiting forever.
 */
export type OperatorConsoleVisibility = 'show' | 'hide' | 'pending';

export function operatorConsoleVisibility(input: {
	deploymentMode: string | undefined;
	workspaceCount: number | undefined;
	isCountUnavailable?: boolean;
}): OperatorConsoleVisibility {
	if (input.deploymentMode !== 'selfhost') return 'show';
	if (input.workspaceCount === undefined) return input.isCountUnavailable ? 'show' : 'pending';
	return input.workspaceCount > 1 ? 'show' : 'hide';
}

/** Where a hidden console sends its visitor: the page its overview repeated. */
export const OPERATOR_CONSOLE_FALLBACK_ROUTE = '/dashboard/admin/delivery';

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

/**
 * Format a 0–1 rate as a percentage string (e.g. 0.0123 → "1.23%"). With a
 * locale, the number is written the way that locale writes it ("1,23 %" in
 * German); without one it keeps the plain form.
 */
export function formatRate(rate: number | undefined, locale?: string): string {
	if (rate === undefined || Number.isNaN(rate)) return '—';
	if (locale === undefined) return formatPercentage(rate, 2, true);
	return new Intl.NumberFormat(locale, {
		style: 'percent',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(rate);
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
