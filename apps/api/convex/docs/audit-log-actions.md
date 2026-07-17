# Audit Log Action Catalog

Each row in `auditLogs` has `action`, `resource`, optional `resourceId`,
optional flat-scalar `details`, and optional `detailsBlob` (JSON-encoded
string for nested payloads). The action ↔ resource pairing is enforced
by `auditActionValidator` and `auditResourceValidator` in
`lib/validators.ts`.

All inserts must go through `recordAuditLog(ctx, {...})` in
`lib/auditLog.ts`. The public `auditLogs.create` and internal
`createInternal` mutations have been removed.

## When to use `details` vs `detailsBlob`

| Use `details` | Use `detailsBlob` |
| --- | --- |
| Flat scalar map (string/number/boolean/null) | Nested objects, arrays, or change-tracking `{ from, to }` |
| Fast indexed reads | Free-form payload at the cost of `JSON.parse` on read |

## Action catalog

| Action | Resource | Expected `details` |
| --- | --- | --- |
| `campaign.created` | `campaign` | `{ name }` |
| `campaign.updated` | `campaign` | `detailsBlob: { changes: { field: { from, to } } }` |
| `campaign.deleted` | `campaign` | `{ name }` |
| `campaign.sent` | `campaign` | `{ name, audienceCount }` |
| `campaign.scheduled` | `campaign` | `{ name, scheduledAt }` |
| `campaign.cancelled` | `campaign` | `{ name }` |
| `contact.created` | `contact` | `{ email }` |
| `contact.updated` | `contact` | `{ changedProperties }` (comma-joined field names) |
| `contact.deleted` | `contact` | `{ email }` (soft-delete; hard cascade happens in cron; also emitted per-row by `bulkDelete`) |
| `contact.imported` | `contact` | `{ count, source }` |
| `contact.merged` | `contact` | `{ sourceContactId, sourceEmail }` (target is `resourceId`; source hard-deleted) |
| `topic.created` / `topic.updated` / `topic.deleted` | `topic` | `{ name }` |
| `email_template.created` | `email_template` | `{ name, type }` |
| `email_template.updated` | `email_template` | `detailsBlob: { changes: {...} }` |
| `email_template.deleted` | `email_template` | `{ name }` |
| `email_template.published` / `email_template.unpublished` | `email_template` | `{ previousStatus, newStatus }` (see ADR-0022) |
| `email_template.duplicated` | `email_template` | `{ sourceTemplateId, name }` |
| `transactional_email.created` | `transactional_email` | `{ name, slug }` |
| `transactional_email.updated` | `transactional_email` | `detailsBlob: { changes: {...} }` |
| `transactional_email.deleted` | `transactional_email` | `{ name, slug }` |
| `transactional_email.published` / `transactional_email.unpublished` | `transactional_email` | `{ previousStatus, newStatus }` (see ADR-0022) |
| `transactional_email.flagged_for_review` | `transactional_email` | `{ previousStatus, newStatus, score }` (scan suspicious; see ADR-0022) |
| `transactional_email.approved` / `transactional_email.rejected` | `transactional_email` | `{ previousStatus, newStatus }` (admin review; see ADR-0022) |
| `transactional_email.duplicated` | `transactional_email` | `{ sourceEmailId, name, slug }` |
| `automation.created` / `automation.updated` / `automation.deleted` | `automation` | `{ name }` |
| `automation.activated` / `automation.paused` | `automation` | `{ name }` |
| `settings.updated` | `settings` | Workspace settings: `detailsBlob: { changes: {...} }`. Plugin settings (`plugins/settings.ts`, carrying the plugin id): a partial update emits `{ pluginId, changedFields }` (changed field keys only, never their values, so a secret can never enter the trail); a reset emits `{ pluginId, reset: true }`. |
| `ai_provider_config.updated` | `ai_provider_config` | `detailsBlob: { languageProviderKind, modelFast, modelCapable, embeddingProviderKind, embeddingModel, embeddingModelVersion, isLanguageKeySet, isEmbeddingKeySet }` (never the key) |
| `team_member.invited` | `team_member` | `{ email, role }` |
| `team_member.removed` | `team_member` | `{ email }` |
| `team_member.role_changed` | `team_member` | `{ email, fromRole, toRole }` |
| `api_key.created` / `api_key.revoked` | `api_key` | `{ name }` |
| `webhook.created` / `webhook.updated` / `webhook.deleted` | `webhook` | `{ url, name }` |
| `webhook.secret_rotated` | `webhook` | `{ name }` (signing secret regenerated) |
| `domain.added` / `domain.verified` / `domain.removed` | `domain` | `{ domain }` |
| `blocklist.added` / `blocklist.removed` | `blocklist` | `{ email, reason }` |
| `segment.created` / `segment.updated` / `segment.deleted` | `segment` | `{ name }` |
| `platform_admin.org_status_changed` | `platform_admin` | `{ previousStatus, newStatus, reason }` |
| `platform_admin.tier_override` | `platform_admin` | `{ tier }` |
| `platform_admin.content_approved` / `content_rejected` | `platform_admin` | `{ type, name, notes? \| reason }` |
| `platform_admin.waitlist_approved` / `waitlist_rejected` | `platform_admin` | `{ orgName, reason? }` |
| `platform_admin.admin_added` | `platform_admin` | `{ email, role, addedBy }` |
| `platform_admin.admin_removed` | `platform_admin` | `{ email, role }` |
| `inbound.received` / `quarantined` / `released` / `retried` | `inbound_message` | _empty_ |
| `inbound.draft_approved` / `draft_rejected` / `draft_edited` | `inbound_message` | `{ reason? }` |
| `inbound.reply_sent` | `inbound_message` | _empty_ |
| `inbound.clarification_answered` | `inbound_message` | _empty_ |
| `inbound.sender_blocked` | `inbound_message` | `{ email }` |
| `agent.config_updated` | `agent_config` | `detailsBlob: { ...patchedFields }` |
| `agent.backfill_started` / `backfill_cancelled` | `agent_config` | `{ jobId }` |
| `agent.kill_switch` | `agent_config` | `{ revertedToDraftOnly }` |
| `agent.demotion_acknowledged` | `autonomy_rule` | `{ category, sender }` |
| `knowledge.edge_backfill_started` / `edge_backfill_cancelled` | `knowledge_config` | `{ jobId }` |
| `abuse_status_changed` | `instance_settings` | `{ previousStatus, newStatus, reason, changedBy }` (see ADR-0011) |
| `postbox_outbound_transition` | `mail_message` | `{ mailboxId, recipientIdx, from, to, aggregateBefore, aggregateAfter, at, bounceMessage?, errorMessage?, errorCode? }` (see ADR-0012) |
| `plugin.action_completed` / `plugin.action_failed` / `plugin.action_denied` | `plugin` | Dedicated `organizationId` + `pluginId`; allowlisted `{ operation, outcome, attempts?, usageAvailable?, chargedMicrousd?, actualMicrousd?, reasonCode? }`. Never storage keys/values/cursors, prompts/results, secrets, or raw errors. |
| `connected_app.registered` / `connected_app.enabled` / `connected_app.disabled` / `connected_app.revoked` / `connected_app.deleted` / `connected_app.secret_rotated` | `connected_app` | Tier-2 connected-app lifecycle (`connectedApps/*`). Dedicated `organizationId` + `pluginId`; scalar `{ pluginId, capabilityCount }`. Never the endpoint URL, the shared secret, or its sealed envelope. |

## Extending

To add a new action:
1. Append the literal to `auditActions/catalog.ts` `AUDIT_ACTION_LITERALS`
   (and `AUDIT_RESOURCE_LITERALS` if the action introduces a new resource
   kind). The schema validator + `lib/validators.ts` `auditActionValidator`
   derive from this catalog automatically.
2. Add a row to the table above documenting the expected payload.
3. Call `recordAuditLog` from the mutation that owns the action.
