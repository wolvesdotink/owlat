/**
 * The task-card kind registry — the open, host-mediated source of truth for the
 * kinds a focused task-flow can contain (Reply Queue + Review Queue) and the
 * card component that renders each one.
 *
 * The three built-in kinds (`question`, `draft_review`, `reply`) are seeded at
 * construction and can never be removed, reordered ahead of each other, or have
 * their metadata overwritten — so the existing queue ordering and time-estimate
 * behavior is preserved exactly. A statically-composed plugin may APPEND its own
 * `plugin.*`-namespaced kind (with a lazy card component and an optional gating
 * flag); it can never displace a built-in, redefine one, or register a second
 * card for a kind that already exists.
 *
 * Ordering is deterministic: built-ins keep ranks 0/1/2, plugin kinds take ranks
 * after every built-in in registration order, and an unknown (never-registered)
 * kind sorts last of all. Unknown and flag-disabled kinds resolve to a graceful
 * fallback placeholder rather than crashing or dropping the queue item.
 *
 * SECURITY. A plugin's `label` is untrusted, manifest-sourced text: it is
 * coerced to a string, trimmed, and length-clamped here and only ever rendered
 * as a text node (never `v-html`). `estimateSeconds` is clamped to a sane range
 * so a plugin cannot poison the whole flow's time estimate.
 */

import type { Component } from 'vue';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { TaskFlowKind } from './taskFlow';

/** The kinds Owlat ships, in their canonical order (questions first). */
export const BUILT_IN_TASK_FLOW_KINDS = ['question', 'draft_review', 'reply'] as const;
export type BuiltInTaskFlowKind = (typeof BUILT_IN_TASK_FLOW_KINDS)[number];

const BUILT_IN_KIND_SET: ReadonlySet<string> = new Set(BUILT_IN_TASK_FLOW_KINDS);

/** True for a kind Owlat ships natively (as opposed to a plugin contribution). */
export function isBuiltInTaskFlowKind(kind: string): kind is BuiltInTaskFlowKind {
	return BUILT_IN_KIND_SET.has(kind);
}

/**
 * True for a correctly namespaced task-card kind: `plugin.<pluginId>.<localKind>`
 * where each segment is lowercase alphanumeric-with-hyphens starting with a
 * letter. This matches the platform's namespaced-kind grammar (plugin-kit's
 * STEP_REFERENCE, the Convex cron prefix check) so a task-card kind can always
 * be attributed to its owning plugin — a single-segment or mixed-case kind is
 * rejected, not silently accepted.
 */
export function isPluginTaskFlowKind(kind: string): boolean {
	return /^plugin\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(kind);
}

/** Lazily-loaded card component for a plugin kind (SSR-safe dynamic import). */
export type TaskCardComponentLoader = () => Promise<Component | { default: Component }>;

/** The registry's per-kind record. Built-ins carry no `load` (rendered natively). */
export interface TaskCardKindDefinition {
	readonly kind: TaskFlowKind;
	/** Sort weight — lower first. Assigned by the registry, never by the plugin. */
	readonly rank: number;
	/** Rough per-card time budget (seconds) for the "about N min" hint. */
	readonly estimateSeconds: number;
	/** Human label for the peek line and fallback placeholder (untrusted text). */
	readonly label: string;
	/** Feature flag gating a plugin kind; absent for built-ins (always on). */
	readonly flag?: FeatureFlagKey;
	/** Lazy card component for a plugin kind; absent for built-ins. */
	readonly load?: TaskCardComponentLoader;
}

/** Bounds on plugin-supplied metadata (untrusted). */
const MIN_ESTIMATE_SECONDS = 5;
const MAX_ESTIMATE_SECONDS = 600;
const MAX_LABEL_LENGTH = 80;
/** Time budget used for a kind with no registered estimate. */
export const DEFAULT_TASK_CARD_SECONDS = 60;
/** Rank for any kind not present in the registry — sorts after everything. */
export const UNKNOWN_TASK_CARD_RANK = Number.MAX_SAFE_INTEGER;

/** Built-in metadata, kept identical to the pre-registry constants. */
const BUILT_IN_DEFINITIONS: readonly TaskCardKindDefinition[] = [
	{ kind: 'question', rank: 0, estimateSeconds: 45, label: 'Question' },
	{ kind: 'draft_review', rank: 1, estimateSeconds: 60, label: 'Draft review' },
	{ kind: 'reply', rank: 2, estimateSeconds: 120, label: 'Reply' },
];

/** A plugin's contribution before the registry assigns its rank. */
export interface TaskCardKindRegistration {
	readonly kind: TaskFlowKind;
	readonly estimateSeconds?: number;
	readonly label: string;
	readonly flag?: FeatureFlagKey;
	readonly load: TaskCardComponentLoader;
}

/** How a kind resolves to something renderable, for the card dispatcher. */
export type TaskCardResolution =
	| {
			readonly status: 'plugin';
			readonly definition: TaskCardKindDefinition;
			readonly load: TaskCardComponentLoader;
	  }
	| { readonly status: 'disabled'; readonly kind: TaskFlowKind; readonly label: string }
	| { readonly status: 'unknown'; readonly kind: TaskFlowKind };

function clampEstimate(seconds: number | undefined): number {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return DEFAULT_TASK_CARD_SECONDS;
	return Math.min(MAX_ESTIMATE_SECONDS, Math.max(MIN_ESTIMATE_SECONDS, Math.round(seconds)));
}

function clampLabel(label: string): string {
	return String(label ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_LABEL_LENGTH);
}

export class TaskCardRegistry {
	private readonly byKind = new Map<string, TaskCardKindDefinition>();
	/** Monotonic counter so plugin ranks are stable in registration order. */
	private nextPluginRank = BUILT_IN_TASK_FLOW_KINDS.length;

	constructor() {
		for (const def of BUILT_IN_DEFINITIONS) this.byKind.set(def.kind, def);
	}

	/**
	 * Append a plugin-contributed kind. Rejects (throws) a kind that is not
	 * `plugin.*`-namespaced, that collides with a built-in or an already
	 * registered kind (late/duplicate registration), or that has no card loader.
	 * Metadata is clamped before it is stored.
	 */
	register(registration: TaskCardKindRegistration): TaskCardKindDefinition {
		const { kind } = registration;
		if (isBuiltInTaskFlowKind(kind)) {
			throw new Error(`Task-card kind "${kind}" is built in and cannot be overridden`);
		}
		if (!isPluginTaskFlowKind(kind)) {
			throw new Error(`Task-card kind "${kind}" must be namespaced as "plugin.<id>"`);
		}
		if (this.byKind.has(kind)) {
			throw new Error(`Task-card kind "${kind}" is already registered`);
		}
		if (typeof registration.load !== 'function') {
			throw new Error(`Task-card kind "${kind}" must supply a card component loader`);
		}
		const definition: TaskCardKindDefinition = Object.freeze({
			kind,
			rank: this.nextPluginRank++,
			estimateSeconds: clampEstimate(registration.estimateSeconds),
			label: clampLabel(registration.label) || kind,
			flag: registration.flag,
			load: registration.load,
		});
		this.byKind.set(kind, definition);
		return definition;
	}

	/** The definition for a kind, or `undefined` if it was never registered. */
	get(kind: string): TaskCardKindDefinition | undefined {
		return this.byKind.get(kind);
	}

	/** Sort weight for a kind; unknown kinds sort last (stable via input order). */
	rank(kind: string): number {
		return this.byKind.get(kind)?.rank ?? UNKNOWN_TASK_CARD_RANK;
	}

	/** Time budget for a kind; unknown kinds fall back to the default. */
	estimateSeconds(kind: string): number {
		return this.byKind.get(kind)?.estimateSeconds ?? DEFAULT_TASK_CARD_SECONDS;
	}

	/** Every registered kind in rank order (built-ins first, plugins appended). */
	list(): readonly TaskCardKindDefinition[] {
		return [...this.byKind.values()].sort((a, b) => a.rank - b.rank);
	}

	/**
	 * Resolve a kind for the card dispatcher, honoring the gating flag:
	 *   - a built-in reaching the dispatcher has no plugin card → `unknown`
	 *     (its native branch renders it; the dispatcher is only the fallback);
	 *   - a registered plugin kind whose flag is off → `disabled`;
	 *   - a registered, enabled plugin kind → `plugin` (render its card);
	 *   - anything unregistered → `unknown`.
	 *
	 * The predicate defaults to fail-closed (`() => false`): a gated kind with no
	 * predicate resolves to `disabled`, never enabled. Ungated kinds (no `flag`)
	 * are unaffected — the predicate is never consulted for them.
	 */
	resolve(
		kind: TaskFlowKind,
		isFlagEnabled: (flag: FeatureFlagKey) => boolean = () => false
	): TaskCardResolution {
		const definition = this.byKind.get(kind);
		if (!definition || !definition.load) return { status: 'unknown', kind };
		if (definition.flag && !isFlagEnabled(definition.flag)) {
			return { status: 'disabled', kind, label: definition.label };
		}
		return { status: 'plugin', definition, load: definition.load };
	}
}

/** Build a fresh registry (seeded with built-ins). Tests use this for isolation. */
export function createTaskCardRegistry(): TaskCardRegistry {
	return new TaskCardRegistry();
}

/** The app-wide registry the focused flows and the card dispatcher read from. */
export const taskCardRegistry = createTaskCardRegistry();
