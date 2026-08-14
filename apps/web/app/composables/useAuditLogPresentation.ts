/**
 * Single source of truth for how audit-log rows are PRESENTED (labels, icons,
 * colours) and for the translated row formatters the list renders.
 *
 * The four presentation switches (resource icon / resource label / action label
 * / action icon / action colour) used to live inline in `audit.vue` and were
 * edited in lockstep. They now live here so the page holds only fetch wiring +
 * template.
 *
 * The two filter catalogs — the resource dropdown and the grouped action
 * dropdown derived from the backend SSOT — live in `auditLogFilterCatalog.ts`,
 * split out to keep this file under the size cap. They are imported (not
 * re-exported) because both files sit at the top level of `composables/`, which
 * Nuxt auto-imports: re-exporting would register every name twice.
 */
import {
	AUDIT_ACTION_LITERALS,
	HOSTED_PLUGIN_OPERATION_LITERALS,
	type HostedPluginOperationLiteral,
} from '@owlat/api/auditActions';
import type { Id } from '@owlat/api/dataModel';
import { isPluginId } from '@owlat/plugin-kit';
import { capitalize } from '../utils/formatters';
import { buildActionTypeGroups, RESOURCE_FILTER_OPTIONS } from './auditLogFilterCatalog';

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
	seed_mailbox: 'lucide:inbox',
	ai_provider_config: 'lucide:sparkles',
	plugin: 'lucide:blocks',
	connected_app: 'lucide:plug',
	deliverability_ramp: 'lucide:trending-up',
};

const RESOURCES = 'shared.useAuditLogPresentation.resources';

const RESOURCE_LABELS: Record<string, string> = {
	campaign: `${RESOURCES}.campaign`,
	contact: `${RESOURCES}.contact`,
	topic: `${RESOURCES}.topic`,
	email_template: `${RESOURCES}.emailTemplate`,
	automation: `${RESOURCES}.automation`,
	settings: `${RESOURCES}.settings`,
	team_member: `${RESOURCES}.teamMember`,
	api_key: `${RESOURCES}.apiKey`,
	webhook: `${RESOURCES}.webhook`,
	domain: `${RESOURCES}.domain`,
	blocklist: `${RESOURCES}.blocklist`,
	segment: `${RESOURCES}.segment`,
	seed_mailbox: `${RESOURCES}.seedMailbox`,
	ai_provider_config: `${RESOURCES}.aiProviderConfig`,
	plugin: `${RESOURCES}.plugin`,
	connected_app: `${RESOURCES}.connectedApp`,
	deliverability_ramp: `${RESOURCES}.deliverabilityRamp`,
};

const ACTIONS = 'shared.useAuditLogPresentation.actions';

const ACTION_VERB_LABELS: Record<string, string> = {
	created: `${ACTIONS}.created`,
	updated: `${ACTIONS}.updated`,
	deleted: `${ACTIONS}.deleted`,
	sent: `${ACTIONS}.sent`,
	scheduled: `${ACTIONS}.scheduled`,
	cancelled: `${ACTIONS}.cancelled`,
	imported: `${ACTIONS}.imported`,
	published: `${ACTIONS}.published`,
	activated: `${ACTIONS}.activated`,
	paused: `${ACTIONS}.paused`,
	invited: `${ACTIONS}.invited`,
	removed: `${ACTIONS}.removed`,
	role_changed: `${ACTIONS}.roleChanged`,
	revoked: `${ACTIONS}.revoked`,
	added: `${ACTIONS}.added`,
	verified: `${ACTIONS}.verified`,
	completed: `${ACTIONS}.completed`,
	failed: `${ACTIONS}.failed`,
	denied: `${ACTIONS}.denied`,
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
const OPERATIONS = 'shared.useAuditLogPresentation.hostedPluginOperations';

/** Message keys, one per backend hosted-operation literal. */
const HOSTED_PLUGIN_OPERATION_LABEL_KEYS = {
	'agent.step': `${OPERATIONS}.agentStep`,
	'automation.step': `${OPERATIONS}.automationStep`,
	'autonomy.gate': `${OPERATIONS}.autonomyGate`,
	'cron.run': `${OPERATIONS}.cronRun`,
	'draft.strategy': `${OPERATIONS}.draftStrategy`,
	'import.provider': `${OPERATIONS}.importProvider`,
	'llm.generate': `${OPERATIONS}.llmGenerate`,
	'storage.delete': `${OPERATIONS}.storageDelete`,
	'storage.get': `${OPERATIONS}.storageGet`,
	'storage.list': `${OPERATIONS}.storageList`,
	'storage.set': `${OPERATIONS}.storageSet`,
	'transport.domain_identity': `${OPERATIONS}.transportDomainIdentity`,
	'transport.feedback': `${OPERATIONS}.transportFeedback`,
	'transport.send': `${OPERATIONS}.transportSend`,
	'webhook.publish': `${OPERATIONS}.webhookPublish`,
	'worker.enqueue': `${OPERATIONS}.workerEnqueue`,
	'worker.run': `${OPERATIONS}.workerRun`,
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

/**
 * A message key for a known resource; an UNKNOWN resource falls back to the raw
 * backend key, which `t()` renders unchanged — the pre-extraction behaviour.
 */
export function getResourceLabel(resource: string): string {
	return RESOURCE_LABELS[resource] ?? resource;
}

/**
 * A message key for a known verb; a verb the catalog does not carry falls back
 * to the humanised literal, which `t()` renders unchanged (so a freshly added
 * backend action still reads as words rather than a raw key path).
 */
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
 * The two hosted-action discriminators that are safe and useful in the audit
 * list. Arbitrary details fields are deliberately ignored. `pluginId` is an
 * identifier (never translated); the operation travels as a message key, and
 * the composable below is what turns the pair into a sentence.
 */
export interface HostedPluginDetail {
	pluginId?: string;
	/** A message key for the operation label. */
	operationKey?: string;
}

export function getHostedPluginDetail(log: AuditLogEntry): HostedPluginDetail | undefined {
	if (log.resource !== 'plugin' || !HOSTED_PLUGIN_ACTIONS.has(log.action)) return undefined;
	return {
		pluginId: safePluginId(log.pluginId) ?? safePluginId(log.resourceId),
		operationKey: hostedPluginOperationLabelKey(log.details),
	};
}

function safePluginId(value: unknown): string | undefined {
	return isPluginId(value) ? value : undefined;
}

function hostedPluginOperationLabelKey(details: Record<string, unknown> | undefined) {
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
		? HOSTED_PLUGIN_OPERATION_LABEL_KEYS[descriptor.value as HostedPluginOperationLiteral]
		: undefined;
}

// ---------------------------------------------------------------------------
// Row formatters — timestamp, full date, details, initials. These keep the
// audit page's exact wording ("Just now", "X minute(s) ago", absolute date past
// 7 days) deliberately distinct from the shared formatRelativeTime helper so the
// rendered output does not change.
// ---------------------------------------------------------------------------

const TIMESTAMPS = 'shared.useAuditLogPresentation.timestamp';

const plural = (count: number): 'one' | 'other' => (count === 1 ? 'one' : 'other');

/** The relative-time message for a timestamp, or `null` once it is older than
 * the 7-day window the audit list renders as an absolute date. Each unit
 * carries its own `one`/`other` key so the caller resolves it with a plain
 * `t(key, params)`. */
export function relativeTimestampMessage(
	timestamp: number,
	now: number = Date.now()
): { key: string; params: { count: number } } | null {
	const diffMs = now - timestamp;
	const diffMins = Math.floor(diffMs / (1000 * 60));
	const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffMins < 1) return { key: `${TIMESTAMPS}.justNow`, params: { count: 0 } };
	if (diffMins < 60) {
		return { key: `${TIMESTAMPS}.minutes.${plural(diffMins)}`, params: { count: diffMins } };
	}
	if (diffHours < 24) {
		return { key: `${TIMESTAMPS}.hours.${plural(diffHours)}`, params: { count: diffHours } };
	}
	if (diffDays < 7) {
		return { key: `${TIMESTAMPS}.days.${plural(diffDays)}`, params: { count: diffDays } };
	}
	return null;
}

const SHORT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
};

const FULL_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
	year: 'numeric',
	month: 'long',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
};

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
 *
 * The label/icon/colour switches above hand back message KEYS (they are module
 * scope and cannot translate); the row formatters returned here are the
 * translated closures the list renders, and they format dates against the
 * ACTIVE locale rather than a pinned one.
 */
export function useAuditLogPresentation() {
	const { t, locale } = useI18n();
	const actionTypeGroups = buildActionTypeGroups();

	const formatTimestamp = (timestamp: number): string => {
		const relative = relativeTimestampMessage(timestamp);
		if (relative) return t(relative.key, relative.params);
		return new Intl.DateTimeFormat(locale.value, SHORT_DATE_OPTIONS).format(new Date(timestamp));
	};

	const formatFullDate = (timestamp: number): string =>
		new Intl.DateTimeFormat(locale.value, FULL_DATE_OPTIONS).format(new Date(timestamp));

	const getHostedPluginDetailText = (log: AuditLogEntry): string | undefined => {
		const detail = getHostedPluginDetail(log);
		if (!detail) return undefined;
		const operation = detail.operationKey ? t(detail.operationKey) : undefined;
		if (detail.pluginId && operation) {
			return t('shared.useAuditLogPresentation.hostedPluginDetail.pluginAndOperation', {
				pluginId: detail.pluginId,
				operation,
			});
		}
		// A plugin id is an identifier, not copy — it renders as itself.
		return (
			detail.pluginId ??
			operation ??
			t('shared.useAuditLogPresentation.hostedPluginDetail.fallback')
		);
	};

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
