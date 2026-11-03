/**
 * Shared presentation map for knowledge-graph entry types and sources.
 *
 * This is the single source of truth for how a knowledge entry type (and its
 * source) is rendered across the app — icon, badge variant, and human label.
 * `useKnowledgeGraph` re-exports these so composable consumers keep their
 * existing API, while leaf components (that don't need the full composable)
 * can import the accessors directly via `~/utils/knowledgeEntryTypes`.
 */

import {
	BookOpenIcon,
	CalendarIcon,
	ChatCircleIcon,
	CircleHelpIcon,
	CircleIcon,
	FileIcon,
	GavelIcon,
	HeartIcon,
	LinkIcon,
	MailIcon,
	PencilIcon,
	RobotIcon,
	ShieldCheckIcon,
	SquareCheckIcon,
	TargetIcon,
	WavyCheckIcon,
	type IconComponent,
} from '@coolicons/vue';

export type EntryType =
	| 'fact'
	| 'decision'
	| 'event'
	| 'preference'
	| 'goal'
	| 'relationship'
	| 'action_item'
	| 'policy'
	| 'faq';

export type EntryTypeVariant = 'default' | 'success' | 'warning' | 'error' | 'neutral';

// Mirrors the backend ENTRY_TYPES tuple (schema/knowledge.ts): the seven types
// people and the agent record, plus the two curated canonical-answer types.
// Drives the list tabs, the legend and the graph filter.
export const ENTRY_TYPES: EntryType[] = [
	'fact',
	'decision',
	'event',
	'preference',
	'goal',
	'relationship',
	'action_item',
	'policy',
	'faq',
];

// Policy and FAQ entries are canonical answers: they are written through the
// canonical-answer form, which marks them authoritative. The generic entry form
// offers only the other seven.
export const POLICY_ENTRY_TYPES: readonly EntryType[] = ['policy', 'faq'];
export const AUTHORABLE_ENTRY_TYPES: EntryType[] = ENTRY_TYPES.filter(
	(type) => !POLICY_ENTRY_TYPES.includes(type)
);

export const TYPE_CONFIG: Record<
	EntryType,
	{ variant: EntryTypeVariant; icon: IconComponent; label: string }
> = {
	fact: { variant: 'default', icon: BookOpenIcon, label: 'Fact' },
	decision: { variant: 'warning', icon: GavelIcon, label: 'Decision' },
	event: { variant: 'neutral', icon: CalendarIcon, label: 'Event' },
	preference: { variant: 'neutral', icon: HeartIcon, label: 'Preference' },
	goal: { variant: 'success', icon: TargetIcon, label: 'Goal' },
	relationship: { variant: 'error', icon: LinkIcon, label: 'Relationship' },
	action_item: { variant: 'warning', icon: SquareCheckIcon, label: 'Action Item' },
	policy: { variant: 'success', icon: ShieldCheckIcon, label: 'Policy' },
	faq: { variant: 'default', icon: CircleHelpIcon, label: 'FAQ' },
};

// Mirrors the backend sourceTypeValidator union (schema/knowledge.ts).
export type SourceType = 'email' | 'chat' | 'manual' | 'file' | 'agent_extracted' | 'curated';

export const SOURCE_CONFIG: Record<string, { icon: IconComponent; label: string }> = {
	email: { icon: MailIcon, label: 'Email' },
	chat: { icon: ChatCircleIcon, label: 'Chat' },
	manual: { icon: PencilIcon, label: 'Manual' },
	file: { icon: FileIcon, label: 'File' },
	agent_extracted: { icon: RobotIcon, label: 'AI Extracted' },
	curated: { icon: WavyCheckIcon, label: 'Canonical answer' },
};

// A hand-authored entry is always `manual`: the backend refuses any other
// source on create (the rest name a pipeline, and `curated` has its own
// canonical-answer form), and an edit keeps the entry's existing source.
export const AUTHORABLE_SOURCE_TYPES: SourceType[] = ['manual'];

export const entryTypeVariant = (type: string): EntryTypeVariant =>
	TYPE_CONFIG[type as EntryType]?.variant ?? 'neutral';
export const entryTypeIcon = (type: string): IconComponent =>
	TYPE_CONFIG[type as EntryType]?.icon ?? CircleIcon;
export const entryTypeLabel = (type: string): string =>
	TYPE_CONFIG[type as EntryType]?.label ?? type;

export const sourceIcon = (source: string): IconComponent =>
	SOURCE_CONFIG[source]?.icon ?? CircleIcon;
export const sourceLabel = (source: string): string => SOURCE_CONFIG[source]?.label ?? source;

// Mirrors the backend RELATION_TYPES tuple (schema/knowledge.ts) — the six typed
// edges a relation between two entries can carry.
export type RelationType =
	| 'supports'
	| 'contradicts'
	| 'supersedes'
	| 'relates_to'
	| 'causes'
	| 'blocks';

export const RELATION_TYPES: RelationType[] = [
	'supports',
	'contradicts',
	'supersedes',
	'relates_to',
	'causes',
	'blocks',
];

// Single source of truth for how a relation type is rendered — badge classes +
// human label — shared by the picker (entry detail page) and RelationsList.
const RELATION_CONFIG: Record<RelationType, { label: string; badgeClass: string }> = {
	supports: { label: 'Supports', badgeClass: 'bg-success-subtle text-success' },
	contradicts: { label: 'Contradicts', badgeClass: 'bg-error/10 text-error' },
	supersedes: { label: 'Supersedes', badgeClass: 'bg-info/10 text-info' },
	relates_to: { label: 'Relates to', badgeClass: 'bg-bg-surface text-text-secondary' },
	causes: { label: 'Causes', badgeClass: 'bg-warning/10 text-warning' },
	blocks: { label: 'Blocks', badgeClass: 'bg-error/10 text-error' },
};

export const relationLabel = (type: string): string =>
	RELATION_CONFIG[type as RelationType]?.label ?? type;
export const relationBadgeClass = (type: string): string =>
	RELATION_CONFIG[type as RelationType]?.badgeClass ?? 'bg-bg-surface text-text-secondary';
