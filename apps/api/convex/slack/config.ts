/**
 * Resolve the Slack approvals reference app's runtime configuration from the
 * environment (PP-26). All env reads for the app funnel through here so the
 * "is the app active?" decision has one definition.
 *
 * ACTIVE requires BOTH the signing secret (to authenticate callbacks) and the
 * webhook URL (to post approval requests). When either is missing the app is
 * inert: the restrict-only hold gate returns "safe" and holds nothing, so a
 * deployment that never configured Slack behaves exactly as it did before this
 * app existed (feature-off parity).
 */

import { getOptional } from '../lib/env';

/** Approvers cannot be silently unbounded — a typo can't demand 10_000 votes. */
export const SLACK_APPROVALS_MAX_QUORUM = 25;
export const SLACK_APPROVALS_DEFAULT_QUORUM = 1;
/** TTL clamp: at least a minute, at most a week. Default 24h. */
export const SLACK_APPROVALS_MIN_TTL_MINUTES = 1;
export const SLACK_APPROVALS_MAX_TTL_MINUTES = 60 * 24 * 7;
export const SLACK_APPROVALS_DEFAULT_TTL_MINUTES = 60 * 24;

export interface SlackApprovalsActiveConfig {
	readonly active: true;
	readonly signingSecret: string;
	readonly webhookUrl: string;
	readonly quorum: number;
	readonly ttlMs: number;
}
export type SlackApprovalsConfig = SlackApprovalsActiveConfig | { readonly active: false };

/**
 * Read and normalize the app configuration. Returns `{ active: false }` unless
 * BOTH secrets are present; quorum and TTL are clamped so a malformed value
 * degrades to a safe default rather than an unsatisfiable or trivial policy.
 */
export function readSlackApprovalsConfig(): SlackApprovalsConfig {
	const signingSecret = getOptional('SLACK_APPROVALS_SIGNING_SECRET');
	const webhookUrl = getOptional('SLACK_APPROVALS_WEBHOOK_URL');
	if (!signingSecret || !webhookUrl) return { active: false };
	return Object.freeze({
		active: true,
		signingSecret,
		webhookUrl,
		quorum: clampQuorum(getOptional('SLACK_APPROVALS_QUORUM')),
		ttlMs: clampTtlMinutes(getOptional('SLACK_APPROVALS_TTL_MINUTES')) * 60_000,
	});
}

function clampQuorum(raw: string | undefined): number {
	const parsed = parsePositiveInt(raw);
	if (parsed === null) return SLACK_APPROVALS_DEFAULT_QUORUM;
	return Math.min(Math.max(parsed, 1), SLACK_APPROVALS_MAX_QUORUM);
}

function clampTtlMinutes(raw: string | undefined): number {
	const parsed = parsePositiveInt(raw);
	if (parsed === null) return SLACK_APPROVALS_DEFAULT_TTL_MINUTES;
	return Math.min(
		Math.max(parsed, SLACK_APPROVALS_MIN_TTL_MINUTES),
		SLACK_APPROVALS_MAX_TTL_MINUTES
	);
}

function parsePositiveInt(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}
