/**
 * Single source of truth for how audit-log rows are PRESENTED (labels, icons,
 * colours) and how the action-filter dropdown is built.
 *
 * The action-filter catalog is DERIVED from the backend SSOT
 * (`apps/api/convex/auditActions/catalog.ts` → `AUDIT_ACTION_LITERALS`),
 * imported across the `@owlat/api` package boundary. Previously the audit page
 * kept a hand-maintained copy of the literal list, so a new backend action
 * silently never appeared in the filter dropdown (it had already drifted —
 * `sending_domain.dkim_rotated` was missing). Deriving the list here means a
 * new backend action shows up in the filter automatically, and the parity test
 * (`useAuditLogPresentation.test.ts`) fails the build if any literal is left
 * ungrouped.
 *
 * The four presentation switches (resource icon / resource label / action label
 * / action icon / action colour) used to live inline in `audit.vue` and were
 * edited in lockstep. They now live here so the page holds only fetch wiring +
 * template.
 */
import {
	AUDIT_ACTION_LITERALS,
	HOSTED_PLUGIN_OPERATION_LITERALS,
	type HostedPluginOperationLiteral,
} from '@owlat/api/auditActions';
import type { Id } from '@owlat/api/dataModel';
import { isPluginId } from '@owlat/plugin-kit';
import { capitalize } from '../utils/formatters';

/**
 * A single audit-log row as returned by `api.auditLogs.list`. Lives here (the
 * audit presentation SSOT) so the page and the row-list component share one
 * shape instead of redeclaring it. `details` is a jsonPrimitiveRecord (a plain
 * object), not a JSON string — do NOT JSON.parse it.
 */
export interface AuditLogEntry {
	_id: Id<'auditLogs'>;
	_creationTime: number;
	userId: string;
	action: string;
	resource: string;
	resourceId?: string;
	pluginId?: string;
	details?: Record<string, unknown>;
	ipAddress?: string;
	userAgent?: string;
	createdAt: number;
	userProfile: {
		_id: Id<'userProfiles'>;
		name?: string;
		email: string;
	} | null;
}

/**
 * Dropdown option for the resource filter. The `value` is a UI-level resource
 * key (e.g. `'domain'`), which is intentionally distinct from the backend
 * `AUDIT_RESOURCE_LITERALS` (`'sending_domain'`) — the page passes this value
 * straight to `api.auditLogs.list`'s `resource` filter, so changing it would
 * change behaviour. Kept as-is.
 */
export interface ResourceFilterOption {
	value: string;
	label: string;
}

export const RESOURCE_FILTER_OPTIONS: ResourceFilterOption[] = [
	{ value: '', label: 'All Resources' },
	{ value: 'campaign', label: 'Campaigns' },
	{ value: 'contact', label: 'Contacts' },
	{ value: 'topic', label: 'Topics' },
	{ value: 'email_template', label: 'Email Templates' },
	{ value: 'automation', label: 'Automations' },
	{ value: 'settings', label: 'Settings' },
	{ value: 'team_member', label: 'Team Members' },
	{ value: 'api_key', label: 'API Keys' },
	{ value: 'webhook', label: 'Webhooks' },
	{ value: 'domain', label: 'Domains' },
	{ value: 'blocklist', label: 'Blocklist' },
	{ value: 'segment', label: 'Segments' },
	{ value: 'ai_provider_config', label: 'AI Providers' },
	{ value: 'plugin', label: 'Plugins' },
];

/** A group of action literals shown as an `<optgroup>` in the action filter. */
export interface ActionTypeGroup {
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

const ACTION_GROUP_SPECS: readonly ActionGroupSpec[] = [
	{ label: 'Campaigns', prefixes: ['campaign'] },
	{ label: 'A/B Tests', prefixes: ['ab_test'] },
	{ label: 'Contacts', prefixes: ['contact', 'doi'] },
	{ label: 'Topics', prefixes: ['topic'] },
	{ label: 'Email Templates', prefixes: ['email_template'] },
	{ label: 'Transactional Emails', prefixes: ['transactional_email'] },
	{ label: 'Saved Blocks', prefixes: ['email_block'] },
	{ label: 'Automations', prefixes: ['automation'] },
	{ label: 'Settings & Team', prefixes: ['settings', 'team_member'] },
	{ label: 'API & Webhooks', prefixes: ['api_key', 'webhook'] },
	{ label: 'Sending Domains', prefixes: ['sending_domain'] },
	{ label: 'Blocklist', prefixes: ['blocklist'] },
	{ label: 'Segments', prefixes: ['segment'] },
	{ label: 'Postbox', prefixes: ['postbox_outbound_transition', 'postbox_draft'] },
	{ label: 'Conversations', prefixes: ['thread'] },
	{ label: 'Inbound & Agent', prefixes: ['inbound', 'agent'] },
	{ label: 'Knowledge Graph', prefixes: ['knowledge'] },
	{ label: 'Platform Admin', prefixes: ['platform_admin'] },
	{ label: 'Abuse', prefixes: ['abuse_status_changed'] },
	{ label: 'AI Providers', prefixes: ['ai_provider_config'] },
	{ label: 'Plugins', prefixes: ['plugin'] },
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

// ---------------------------------------------------------------------------
// Presentation switches — resource + action → icon / label / colour.
// ---------------------------------------------------------------------------

const RESOURCE_ICONS: Record<string, string> = {
	campaign: 'lucide:send',
	contact: 'lucide:users',
	topic: 'lucide:mail',
	email_template: 'lucide:file-text',
	automation: 'lucide:zap',
	settings: 'lucide:settings',
	team_member: 'lucide:user',
	api_key: 'lucide:key',
	webhook: 'lucide:webhook',
	domain: 'lucide:globe',
	blocklist: 'lucide:ban',
	segment: 'lucide:target',
	ai_provider_config: 'lucide:sparkles',
	plugin: 'lucide:blocks',
};

const RESOURCE_LABELS: Record<string, string> = {
	campaign: 'Campaign',
	contact: 'Contact',
	topic: 'Topic',
	email_template: 'Email Template',
	automation: 'Automation',
	settings: 'Settings',
	team_member: 'Team Member',
	api_key: 'API Key',
	webhook: 'Webhook',
	domain: 'Domain',
	blocklist: 'Blocklist',
	segment: 'Segment',
	ai_provider_config: 'AI Provider',
	plugin: 'Plugin',
};

const ACTION_VERB_LABELS: Record<string, string> = {
	created: 'Created',
	updated: 'Updated',
	deleted: 'Deleted',
	sent: 'Sent',
	scheduled: 'Scheduled',
	cancelled: 'Cancelled',
	imported: 'Imported',
	published: 'Published',
	activated: 'Activated',
	paused: 'Paused',
	invited: 'Invited',
	removed: 'Removed',
	role_changed: 'Role Changed',
	revoked: 'Revoked',
	added: 'Added',
	verified: 'Verified',
	completed: 'Completed',
	failed: 'Failed',
	denied: 'Denied',
};

const ACTION_VERB_ICONS: Record<string, string> = {
	created: 'lucide:plus',
	added: 'lucide:plus',
	updated: 'lucide:edit',
	role_changed: 'lucide:edit',
	deleted: 'lucide:trash-2',
	removed: 'lucide:trash-2',
	revoked: 'lucide:trash-2',
	sent: 'lucide:send',
	scheduled: 'lucide:calendar',
	cancelled: 'lucide:x',
	imported: 'lucide:refresh-cw',
	published: 'lucide:check',
	verified: 'lucide:check',
	completed: 'lucide:check',
	failed: 'lucide:circle-x',
	denied: 'lucide:ban',
	activated: 'lucide:play',
	paused: 'lucide:pause',
	invited: 'lucide:mail',
};

const ACTION_VERB_COLORS: Record<string, string> = {
	created: 'text-success bg-success/10',
	added: 'text-success bg-success/10',
	activated: 'text-success bg-success/10',
	published: 'text-success bg-success/10',
	verified: 'text-success bg-success/10',
	completed: 'text-success bg-success/10',
	deleted: 'text-error bg-error/10',
	removed: 'text-error bg-error/10',
	revoked: 'text-error bg-error/10',
	cancelled: 'text-error bg-error/10',
	failed: 'text-error bg-error/10',
	denied: 'text-error bg-error/10',
	updated: 'text-brand bg-brand/10',
	role_changed: 'text-brand bg-brand/10',
	sent: 'text-brand bg-brand/10',
	scheduled: 'text-brand bg-brand/10',
	imported: 'text-brand bg-brand/10',
	paused: 'text-warning bg-warning/10',
	invited: 'text-warning bg-warning/10',
};

const HOSTED_PLUGIN_ACTIONS: ReadonlySet<string> = new Set(
	AUDIT_ACTION_LITERALS.filter((action) => action.startsWith('plugin.'))
);
const HOSTED_PLUGIN_OPERATION_LABELS = {
	'agent.step': 'Agent pipeline step',
	'draft.strategy': 'Draft strategy',
	'llm.generate': 'LLM generation',
	'storage.delete': 'Storage delete',
	'storage.get': 'Storage read',
	'storage.list': 'Storage list',
	'storage.set': 'Storage write',
	'transport.send': 'Email transport send',
} as const satisfies Record<HostedPluginOperationLiteral, string>;

/** The verb of an action literal: the segment after the first `.`, or the whole
 * literal for dotless actions. */
const actionVerb = (action: string): string => {
	const parts = action.split('.');
	return parts[1] ?? action;
};

export function getResourceIcon(resource: string): string {
	return RESOURCE_ICONS[resource] ?? 'lucide:clipboard-list';
}

export function getResourceLabel(resource: string): string {
	return RESOURCE_LABELS[resource] ?? resource;
}

export function getActionLabel(action: string): string {
	const verb = actionVerb(action);
	return ACTION_VERB_LABELS[verb] ?? capitalize(verb.replace(/_/g, ' '));
}

export function getActionIcon(action: string): string {
	return ACTION_VERB_ICONS[actionVerb(action)] ?? 'lucide:clipboard-list';
}

export function getActionColorClass(action: string): string {
	return ACTION_VERB_COLORS[actionVerb(action)] ?? 'text-text-secondary bg-bg-surface';
}

/**
 * Render only the two hosted-action discriminators that are safe and useful in
 * the audit list. Arbitrary details fields are deliberately ignored.
 */
export function getHostedPluginDetailText(log: AuditLogEntry): string | undefined {
	if (log.resource !== 'plugin' || !HOSTED_PLUGIN_ACTIONS.has(log.action)) return undefined;
	const pluginId = safePluginId(log.pluginId) ?? safePluginId(log.resourceId);
	const operation = hostedPluginOperationLabel(log.details);
	const parts = [pluginId, operation].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join(' · ') : 'Hosted plugin action';
}

function safePluginId(value: unknown): string | undefined {
	return isPluginId(value) ? value : undefined;
}

function hostedPluginOperationLabel(details: Record<string, unknown> | undefined) {
	if (!details) return undefined;
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(details, 'operation');
	} catch {
		return undefined;
	}
	if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
		return undefined;
	}
	return HOSTED_PLUGIN_OPERATION_LITERALS.includes(descriptor.value as HostedPluginOperationLiteral)
		? HOSTED_PLUGIN_OPERATION_LABELS[descriptor.value as HostedPluginOperationLiteral]
		: undefined;
}

// ---------------------------------------------------------------------------
// Row formatters — timestamp, full date, details, initials. These keep the
// audit page's exact wording ("Just now", "X minute(s) ago", absolute date past
// 7 days) deliberately distinct from the shared formatRelativeTime helper so the
// rendered output does not change.
// ---------------------------------------------------------------------------

export function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / (1000 * 60));
	const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffMins < 1) {
		return 'Just now';
	} else if (diffMins < 60) {
		return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
	} else if (diffHours < 24) {
		return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
	} else if (diffDays < 7) {
		return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
	} else {
		return date.toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	}
}

export function formatFullDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
}

/**
 * `details` is already a plain object from the backend (jsonPrimitiveRecord) —
 * return it as-is. JSON.parse on an object stringifies to "[object Object]" and
 * throws, which previously blanked every detail snippet.
 */
export function parseDetails(
	details: Record<string, unknown> | undefined
): Record<string, unknown> {
	return details ?? {};
}

export function getUserInitials(name: string | undefined, email: string | undefined): string {
	if (name) {
		const parts = name.split(' ');
		if (parts.length >= 2 && parts[0] && parts[1] && parts[0][0] && parts[1][0]) {
			return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
		}
		return name.substring(0, 2).toUpperCase();
	}
	if (email) {
		return email.substring(0, 2).toUpperCase();
	}
	return '??';
}

/**
 * Presentation helpers + the derived filter catalogs for the audit-log page.
 * `actionTypeGroups` is computed once at module evaluation; it is a pure
 * function of the backend SSOT and never changes at runtime.
 */
export function useAuditLogPresentation() {
	const actionTypeGroups = buildActionTypeGroups();

	return {
		resourceTypes: RESOURCE_FILTER_OPTIONS,
		actionTypeGroups,
		getResourceIcon,
		getResourceLabel,
		getActionLabel,
		getActionIcon,
		getActionColorClass,
		getHostedPluginDetailText,
		formatTimestamp,
		formatFullDate,
		parseDetails,
		getUserInitials,
	};
}
