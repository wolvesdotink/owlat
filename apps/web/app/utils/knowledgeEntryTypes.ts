/**
 * Shared presentation map for knowledge-graph entry types and sources.
 *
 * This is the single source of truth for how a knowledge entry type (and its
 * source) is rendered across the app — icon, badge variant, and human label.
 * `useKnowledgeGraph` re-exports these so composable consumers keep their
 * existing API, while leaf components (that don't need the full composable)
 * can import the accessors directly via `~/utils/knowledgeEntryTypes`.
 */

export type EntryType = 'fact' | 'decision' | 'event' | 'preference' | 'goal' | 'relationship' | 'action_item';

export type EntryTypeVariant = 'default' | 'success' | 'warning' | 'error' | 'neutral';

export const ENTRY_TYPES: EntryType[] = ['fact', 'decision', 'event', 'preference', 'goal', 'relationship', 'action_item'];

export const TYPE_CONFIG: Record<EntryType, { variant: EntryTypeVariant; icon: string; label: string }> = {
	fact: { variant: 'default', icon: 'lucide:book-open', label: 'Fact' },
	decision: { variant: 'warning', icon: 'lucide:gavel', label: 'Decision' },
	event: { variant: 'neutral', icon: 'lucide:calendar', label: 'Event' },
	preference: { variant: 'neutral', icon: 'lucide:heart', label: 'Preference' },
	goal: { variant: 'success', icon: 'lucide:target', label: 'Goal' },
	relationship: { variant: 'error', icon: 'lucide:link', label: 'Relationship' },
	action_item: { variant: 'warning', icon: 'lucide:check-square', label: 'Action Item' },
};

// Mirrors the backend sourceTypeValidator union (schema/knowledge.ts).
export type SourceType = 'email' | 'chat' | 'manual' | 'file' | 'agent_extracted';

export const SOURCE_CONFIG: Record<string, { icon: string; label: string }> = {
	email: { icon: 'lucide:mail', label: 'Email' },
	chat: { icon: 'lucide:message-circle', label: 'Chat' },
	manual: { icon: 'lucide:pen-line', label: 'Manual' },
	file: { icon: 'lucide:file', label: 'File' },
	agent_extracted: { icon: 'lucide:bot', label: 'AI Extracted' },
};

export const entryTypeVariant = (type: string): EntryTypeVariant => TYPE_CONFIG[type as EntryType]?.variant ?? 'neutral';
export const entryTypeIcon = (type: string): string => TYPE_CONFIG[type as EntryType]?.icon ?? 'lucide:circle';
export const entryTypeLabel = (type: string): string => TYPE_CONFIG[type as EntryType]?.label ?? type;

export const sourceIcon = (source: string): string => SOURCE_CONFIG[source]?.icon ?? 'lucide:circle';
export const sourceLabel = (source: string): string => SOURCE_CONFIG[source]?.label ?? source;

// Mirrors the backend RELATION_TYPES tuple (schema/knowledge.ts) — the six typed
// edges a relation between two entries can carry.
export type RelationType = 'supports' | 'contradicts' | 'supersedes' | 'relates_to' | 'causes' | 'blocks';

export const RELATION_TYPES: RelationType[] = ['supports', 'contradicts', 'supersedes', 'relates_to', 'causes', 'blocks'];

// Single source of truth for how a relation type is rendered — badge classes +
// human label — shared by the picker (entry detail page) and RelationsList.
export const RELATION_CONFIG: Record<RelationType, { label: string; badgeClass: string }> = {
	supports: { label: 'Supports', badgeClass: 'bg-success-subtle text-success' },
	contradicts: { label: 'Contradicts', badgeClass: 'bg-error/10 text-error' },
	supersedes: { label: 'Supersedes', badgeClass: 'bg-info/10 text-info' },
	relates_to: { label: 'Relates to', badgeClass: 'bg-bg-surface text-text-secondary' },
	causes: { label: 'Causes', badgeClass: 'bg-warning/10 text-warning' },
	blocks: { label: 'Blocks', badgeClass: 'bg-error/10 text-error' },
};

export const relationLabel = (type: string): string => RELATION_CONFIG[type as RelationType]?.label ?? type;
export const relationBadgeClass = (type: string): string =>
	RELATION_CONFIG[type as RelationType]?.badgeClass ?? 'bg-bg-surface text-text-secondary';
