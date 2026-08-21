/**
 * The audit page's two filter catalogs: the resource dropdown, and the grouped
 * action dropdown DERIVED from the backend SSOT
 * (`apps/api/convex/auditActions/catalog.ts` → `AUDIT_ACTION_LITERALS`),
 * imported across the `@owlat/api` package boundary.
 *
 * Previously the audit page kept a hand-maintained copy of the literal list, so
 * a new backend action silently never appeared in the filter dropdown (it had
 * already drifted — `sending_domain.dkim_rotated` was missing). Deriving the
 * list here means a new backend action shows up in the filter automatically, and
 * the parity test (`useAuditLogPresentation.test.ts`) fails the build if any
 * literal is left ungrouped.
 *
 * Split from `useAuditLogPresentation.ts` (which re-exports all of this, so
 * importers are unaffected) to keep that file under the size cap; the row
 * presentation switches and formatters stay there.
 */
import { AUDIT_ACTION_LITERALS } from '@owlat/api/auditActions';

/**
 * Dropdown option for the resource filter. The `value` is a UI-level resource
 * key (e.g. `'domain'`), which is intentionally distinct from the backend
 * `AUDIT_RESOURCE_LITERALS` (`'sending_domain'`) — the page passes this value
 * straight to `api.auditLogs.list`'s `resource` filter, so changing it would
 * change behaviour. Kept as-is.
 */
export interface ResourceFilterOption {
	value: string;
	/** A message key — this module is module scope, so it cannot call `useI18n`. */
	label: string;
}

const FILTERS = 'shared.useAuditLogPresentation.resourceFilters';

export const RESOURCE_FILTER_OPTIONS: ResourceFilterOption[] = [
	{ value: '', label: `${FILTERS}.all` },
	{ value: 'campaign', label: `${FILTERS}.campaign` },
	{ value: 'contact', label: `${FILTERS}.contact` },
	{ value: 'topic', label: `${FILTERS}.topic` },
	{ value: 'email_template', label: `${FILTERS}.emailTemplate` },
	{ value: 'automation', label: `${FILTERS}.automation` },
	{ value: 'settings', label: `${FILTERS}.settings` },
	{ value: 'team_member', label: `${FILTERS}.teamMember` },
	{ value: 'api_key', label: `${FILTERS}.apiKey` },
	{ value: 'webhook', label: `${FILTERS}.webhook` },
	{ value: 'domain', label: `${FILTERS}.domain` },
	{ value: 'blocklist', label: `${FILTERS}.blocklist` },
	{ value: 'segment', label: `${FILTERS}.segment` },
	{ value: 'ai_provider_config', label: `${FILTERS}.aiProviderConfig` },
	{ value: 'plugin', label: `${FILTERS}.plugin` },
	{ value: 'connected_app', label: `${FILTERS}.connectedApp` },
];

/** A group of action literals shown as an `<optgroup>` in the action filter. */
export interface ActionTypeGroup {
	/** A message key — the page translates it onto the `<optgroup>`. */
	label: string;
	actions: string[];
}

/**
 * Group metadata: a display label plus the set of action PREFIXES (the part
 * before the first `.`, or the whole literal for dotless actions like
 * `abuse_status_changed`) that belong to it. `AUDIT_ACTION_LITERALS` is then
 * partitioned over these in catalog order, so a freshly-added backend action
 * lands in the right group automatically — and the parity test fails if any
 * literal's prefix is not claimed by exactly one group here.
 */
interface ActionGroupSpec {
	label: string;
	prefixes: readonly string[];
}

const GROUPS = 'shared.useAuditLogPresentation.actionGroups';

const ACTION_GROUP_SPECS: readonly ActionGroupSpec[] = [
	{ label: `${GROUPS}.campaigns`, prefixes: ['campaign'] },
	{ label: `${GROUPS}.abTests`, prefixes: ['ab_test'] },
	{ label: `${GROUPS}.contacts`, prefixes: ['contact', 'doi'] },
	{ label: `${GROUPS}.topics`, prefixes: ['topic'] },
	{ label: `${GROUPS}.emailTemplates`, prefixes: ['email_template'] },
	{ label: `${GROUPS}.transactionalEmails`, prefixes: ['transactional_email'] },
	{ label: `${GROUPS}.savedBlocks`, prefixes: ['email_block'] },
	{ label: `${GROUPS}.automations`, prefixes: ['automation'] },
	{ label: `${GROUPS}.settingsAndTeam`, prefixes: ['settings', 'team_member'] },
	{ label: `${GROUPS}.apiAndWebhooks`, prefixes: ['api_key', 'webhook'] },
	{ label: `${GROUPS}.sendingDomains`, prefixes: ['sending_domain'] },
	{ label: `${GROUPS}.deliverability`, prefixes: ['deliverability_ramp'] },
	{ label: `${GROUPS}.seedMailboxes`, prefixes: ['seed_mailbox'] },
	{ label: `${GROUPS}.blocklist`, prefixes: ['blocklist'] },
	{ label: `${GROUPS}.segments`, prefixes: ['segment'] },
	{ label: `${GROUPS}.postbox`, prefixes: ['postbox_outbound_transition', 'postbox_draft'] },
	{ label: `${GROUPS}.conversations`, prefixes: ['thread'] },
	{ label: `${GROUPS}.inboundAndAgent`, prefixes: ['inbound', 'agent'] },
	{ label: `${GROUPS}.knowledgeGraph`, prefixes: ['knowledge'] },
	{ label: `${GROUPS}.platformAdmin`, prefixes: ['platform_admin'] },
	{ label: `${GROUPS}.abuse`, prefixes: ['abuse_status_changed'] },
	{ label: `${GROUPS}.aiProviders`, prefixes: ['ai_provider_config'] },
	{ label: `${GROUPS}.plugins`, prefixes: ['plugin'] },
	{ label: `${GROUPS}.connectedApps`, prefixes: ['connected_app'] },
];

/** The prefix of an action literal: everything before the first `.`, or the
 * whole literal for dotless actions (`abuse_status_changed`,
 * `postbox_outbound_transition`). */
const actionPrefix = (action: string): string => {
	const dot = action.indexOf('.');
	return dot === -1 ? action : action.slice(0, dot);
};

/**
 * Build the grouped action-filter catalog from the backend SSOT. Exported (not
 * just the composable return) so the parity test can assert exhaustiveness
 * without standing up Vue.
 */
export function buildActionTypeGroups(): ActionTypeGroup[] {
	const groups: ActionTypeGroup[] = ACTION_GROUP_SPECS.map((spec) => ({
		label: spec.label,
		actions: [],
	}));
	// Index each prefix to its group for O(1) assignment.
	const prefixToGroup = new Map<string, ActionTypeGroup>();
	ACTION_GROUP_SPECS.forEach((spec, i) => {
		const group = groups[i]!;
		for (const prefix of spec.prefixes) prefixToGroup.set(prefix, group);
	});

	for (const action of AUDIT_ACTION_LITERALS) {
		const group = prefixToGroup.get(actionPrefix(action));
		// A new backend action whose prefix is not yet claimed by a group is a
		// drift the parity test catches; at runtime we simply drop it from the
		// dropdown rather than crash the page.
		if (group) group.actions.push(action);
	}

	// Drop any group that ended up empty (e.g. a prefix list with no live
	// literals) so the dropdown has no blank optgroups.
	return groups.filter((g) => g.actions.length > 0);
}
