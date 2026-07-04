/**
 * Audit-log action and resource catalog — single source of truth.
 *
 * Previously the same 58 action literals lived in three places — the
 * `schema/auth.ts` `auditLogs.action` validator, the `lib/validators.ts`
 * `auditActionValidator`, and the `lib/auditLog.ts` typed `recordAuditLog`
 * signature — plus a hand-maintained markdown catalog at
 * `docs/audit-log-actions.md`. Adding an action required edits to all four.
 *
 * The catalog below collapses the literal lists into one. Validators are
 * derived, the schema imports them, the typed signature uses the derived
 * type. Adding an action is now a one-place change.
 *
 * Dashboard activity-feed formatters (currently in
 * `analytics/dashboard.ts`) are intentionally NOT moved here — they cover
 * only 13 of the 58 actions and the central switch is short. Per-action
 * formatter modules can be introduced later if/when the formatter table
 * grows.
 */

import { v, type Validator } from 'convex/values';

// ---------------------------------------------------------------------------
// Action catalog
// ---------------------------------------------------------------------------

const action = <L extends string>(literal: L) => literal;

export const AUDIT_ACTION_LITERALS = [
	// Campaign — lifecycle transitions all fire from
	// `campaigns/lifecycle.ts`. See ADR-0017.
	action('campaign.created'),
	action('campaign.updated'),
	action('campaign.deleted'),
	action('campaign.sent'),
	action('campaign.scheduled'),
	action('campaign.unscheduled'),
	action('campaign.cancelled'),
	action('campaign.send_started'),
	action('campaign.content_blocked'),
	action('campaign.flagged_for_review'),
	action('campaign.review_approved'),
	action('campaign.review_rejected'),
	// AB test — sibling lifecycle, transitions fire from
	// `campaigns/abTestLifecycle.ts`. See ADR-0017.
	action('ab_test.enabled'),
	action('ab_test.testing_started'),
	action('ab_test.winner_declared'),
	action('ab_test.disabled'),
	// Contact
	action('contact.created'),
	action('contact.updated'),
	action('contact.deleted'),
	action('contact.imported'),
	// Irreversible merge: the source contact is hard-deleted into the target.
	action('contact.merged'),
	// DOI lifecycle admin-attest. See ADR-0019.
	action('doi.admin_attested'),
	// Topic
	action('topic.created'),
	action('topic.updated'),
	action('topic.deleted'),
	// Email template — lifecycle transitions all fire from
	// `emailTemplates/lifecycle.ts`. See ADR-0022.
	action('email_template.created'),
	action('email_template.updated'),
	action('email_template.deleted'),
	action('email_template.published'),
	action('email_template.unpublished'),
	action('email_template.duplicated'),
	// Transactional email — sibling lifecycle, transitions fire from
	// `transactional/lifecycle.ts`. See ADR-0022.
	action('transactional_email.created'),
	action('transactional_email.updated'),
	action('transactional_email.published'),
	action('transactional_email.unpublished'),
	action('transactional_email.flagged_for_review'),
	action('transactional_email.approved'),
	action('transactional_email.rejected'),
	action('transactional_email.duplicated'),
	action('transactional_email.deleted'),
	// Saved block — row writes from `emailBlocks/module.ts`, plus the
	// terminal-failure callback from the saved-block rerender pool. See
	// ADR-0023.
	action('email_block.created'),
	action('email_block.updated'),
	action('email_block.duplicated'),
	action('email_block.deleted'),
	action('email_block.rerender_failed'),
	// Automation — lifecycle transitions all fire from
	// `automations/lifecycle.ts`. See ADR-0024.
	action('automation.created'),
	action('automation.updated'),
	action('automation.deleted'),
	action('automation.activated'),
	action('automation.paused'),
	action('automation.resumed'),
	action('automation.reverted_to_draft'),
	// Settings + team
	action('settings.updated'),
	action('team_member.invited'),
	action('team_member.removed'),
	action('team_member.role_changed'),
	// API + webhooks
	action('api_key.created'),
	action('api_key.revoked'),
	action('webhook.created'),
	action('webhook.updated'),
	action('webhook.secret_rotated'),
	action('webhook.deleted'),
	// Sending domain — lifecycle transitions all fire from
	// `domains/lifecycle.ts`. See ADR-0018.
	action('sending_domain.created'),
	action('sending_domain.registered'),
	action('sending_domain.registration_failed'),
	action('sending_domain.verified'),
	action('sending_domain.verification_failed'),
	action('sending_domain.regenerated'),
	action('sending_domain.dmarc_policy_changed'),
	action('sending_domain.dkim_rotated'),
	action('sending_domain.deleted'),
	// Blocklist
	action('blocklist.added'),
	action('blocklist.removed'),
	// Segment
	action('segment.created'),
	action('segment.updated'),
	action('segment.deleted'),
	// Abuse-status changes (any source — admin override, MTA circuit breaker,
	// reputation auto-enforcement). See ADR-0011.
	action('abuse_status_changed'),
	// Postbox outbound state transitions (per recipient). Fired by the
	// Postbox outbound lifecycle module on every transition. See ADR-0012.
	action('postbox_outbound_transition'),
	// Postbox draft lifecycle — fired by the Mail draft lifecycle module
	// on every transition of `mailDrafts.state`. See ADR-0028.
	action('postbox_draft.send_initiated'),
	action('postbox_draft.sent'),
	action('postbox_draft.cancelled'),
	action('postbox_draft.from_revoked'),
	action('postbox_draft.scan_blocked'),
	// Platform admin
	action('platform_admin.org_status_changed'),
	action('platform_admin.tier_override'),
	action('platform_admin.content_approved'),
	action('platform_admin.content_rejected'),
	action('platform_admin.waitlist_approved'),
	action('platform_admin.waitlist_rejected'),
	action('platform_admin.admin_added'),
	action('platform_admin.admin_removed'),
	// Conversation thread lifecycle — fired by the Conversation thread
	// module on inbound-driven reopen + human status/assignment changes +
	// the draft-status projection. See ADR-0032.
	action('thread.reopened_by_inbound'),
	action('thread.status_changed'),
	action('thread.assigned'),
	action('thread.unassigned'),
	action('thread.draft_status_changed'),
	// Inbound + agent
	action('inbound.received'),
	action('inbound.quarantined'),
	action('inbound.released'),
	action('inbound.retried'),
	action('inbound.draft_approved'),
	action('inbound.draft_rejected'),
	action('inbound.draft_edited'),
	action('inbound.reply_sent'),
	action('inbound.auto_send_cancelled'),
	action('inbound.clarification_answered'),
	action('inbound.sender_blocked'),
	action('agent.config_updated'),
	action('agent.backfill_started'),
	action('agent.backfill_cancelled'),
	// Autonomy trust controls. Kill switch reverts to draft-only globally
	// (agentConfigMutations.killSwitch); demotion-acknowledged clears a
	// per-sender auto-demotion incident alert (autonomyOutcome.ts).
	action('agent.kill_switch'),
	action('agent.demotion_acknowledged'),
	// Knowledge graph — the one-shot edge backfill kicked off by the first
	// false→true toggle of `ai.knowledge.autoLink`. See knowledge/edgeBackfill.ts.
	action('knowledge.edge_backfill_started'),
	action('knowledge.edge_backfill_cancelled'),
] as const;

export type AuditActionLiteral = (typeof AUDIT_ACTION_LITERALS)[number];

// ---------------------------------------------------------------------------
// Resource catalog
// ---------------------------------------------------------------------------

export const AUDIT_RESOURCE_LITERALS = [
	'campaign',
	'contact',
	'topic',
	'email_template',
	'transactional_email',
	'email_block',
	'automation',
	'settings',
	'team_member',
	'api_key',
	'webhook',
	'sending_domain',
	'blocklist',
	'segment',
	'platform_admin',
	'instance_settings',
	'inbound_message',
	'agent_config',
	'autonomy_rule',
	'knowledge_config',
	'mail_message',
	'conversation_thread',
] as const;

export type AuditResourceLiteral = (typeof AUDIT_RESOURCE_LITERALS)[number];

// ---------------------------------------------------------------------------
// Convex validators — derived from the catalogs above. The variadic spread
// loses literal-narrowing in TypeScript, so we cast back to the literal-
// union type explicitly. Doing it once here keeps every caller narrowed.
// ---------------------------------------------------------------------------

export const auditActionValidator = v.union(
	...AUDIT_ACTION_LITERALS.map((l) => v.literal(l)),
) as unknown as Validator<AuditActionLiteral>;

export const auditResourceValidator = v.union(
	...AUDIT_RESOURCE_LITERALS.map((l) => v.literal(l)),
) as unknown as Validator<AuditResourceLiteral>;
