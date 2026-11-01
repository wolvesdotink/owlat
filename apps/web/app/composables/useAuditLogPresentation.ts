/**
 * Single source of truth for how audit-log rows are PRESENTED (labels, icons,
 * colours) and for the translated row formatters the list renders.
 *
 * The presentation switches (resource icon / resource label / action label
 * / action icon / action colour) change in lockstep, so they live here and the
 * page holds only fetch wiring + template.
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
import {
	CalendarIcon,
	CheckIcon,
	CircleCloseIcon,
	CircleSlashIcon,
	ClipboardListIcon,
	CloseIcon,
	ComponentIcon,
	DatabaseIcon,
	FileTextIcon,
	GlobeIcon,
	InboxIcon,
	KeyIcon,
	LayersIcon,
	MailIcon,
	PaperPlaneIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	PlugIcon,
	PlusIcon,
	ReloadIcon,
	RouteIcon,
	SettingsIcon,
	SparklesIcon,
	TargetIcon,
	TrashIcon,
	TrendingUpIcon,
	UndoIcon,
	UserIcon,
	UsersIcon,
	WavyCheckIcon,
	WebhookIcon,
	ZapIcon,
	type IconComponent,
} from '@coolicons/vue';

/**
 * A single audit-log row as returned by `api.auditActions.logs.list`. Lives here (the
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

const RESOURCE_ICONS: Record<string, IconComponent> = {
	campaign: PaperPlaneIcon,
	contact: UsersIcon,
	topic: MailIcon,
	email_template: FileTextIcon,
	automation: ZapIcon,
	settings: SettingsIcon,
	team_member: UserIcon,
	api_key: KeyIcon,
	webhook: WebhookIcon,
	domain: GlobeIcon,
	blocklist: CircleSlashIcon,
	segment: TargetIcon,
	seed_mailbox: InboxIcon,
	ai_provider_config: SparklesIcon,
	ai_routing_policy: RouteIcon,
	embedding_space: DatabaseIcon,
	plugin: ComponentIcon,
	connected_app: PlugIcon,
	deliverability_ramp: TrendingUpIcon,
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
	ai_routing_policy: `${RESOURCES}.aiRoutingPolicy`,
	embedding_space: `${RESOURCES}.embeddingSpace`,
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
	attested: `${ACTIONS}.attested`,
	started: `${ACTIONS}.started`,
	resumed: `${ACTIONS}.resumed`,
	staged: `${ACTIONS}.staged`,
	rolled_back: `${ACTIONS}.rolledBack`,
	rebuild_cancelled: `${ACTIONS}.rebuildCancelled`,
};

const ACTION_VERB_ICONS: Record<string, IconComponent> = {
	created: PlusIcon,
	added: PlusIcon,
	updated: PencilIcon,
	role_changed: PencilIcon,
	deleted: TrashIcon,
	removed: TrashIcon,
	revoked: TrashIcon,
	sent: PaperPlaneIcon,
	scheduled: CalendarIcon,
	cancelled: CloseIcon,
	imported: ReloadIcon,
	published: CheckIcon,
	verified: CheckIcon,
	completed: CheckIcon,
	failed: CircleCloseIcon,
	denied: CircleSlashIcon,
	activated: PlayIcon,
	paused: PauseIcon,
	invited: MailIcon,
	attested: WavyCheckIcon,
	started: PlayIcon,
	resumed: PlayIcon,
	staged: LayersIcon,
	rolled_back: UndoIcon,
	rebuild_cancelled: CloseIcon,
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
	attested: 'text-success bg-success/10',
	started: 'text-brand bg-brand/10',
	resumed: 'text-brand bg-brand/10',
	staged: 'text-brand bg-brand/10',
	rolled_back: 'text-warning bg-warning/10',
	rebuild_cancelled: 'text-error bg-error/10',
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

export function getResourceIcon(resource: string): IconComponent {
	return RESOURCE_ICONS[resource] ?? ClipboardListIcon;
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

export function getActionIcon(action: string): IconComponent {
	return ACTION_VERB_ICONS[actionVerb(action)] ?? ClipboardListIcon;
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

function getHostedPluginDetail(log: AuditLogEntry): HostedPluginDetail | undefined {
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
function relativeTimestampMessage(
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
