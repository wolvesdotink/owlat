/**
 * Hosted assistant-tool registry (PP-11).
 *
 * The assistant's tool surface used to be an AI-SDK `ToolSet` map literal built
 * inline in the runner. It is now a registry of hosted *modules*, each carrying
 * the metadata the host enforces around it:
 *
 *   - `flag`   — an optional feature flag; when set and OFF, the host omits the
 *                tool from the assembled set (feature-off ⇒ the tool does not
 *                exist for the model). Every built-in leaves this undefined:
 *                the whole assistant is already gated by `ai.assistant` upstream
 *                and no built-in has an independent flag today. The field is the
 *                seam plugin-contributed tool packs gate on.
 *   - `scope`  — the data-access class the tool operates in. Built-ins are read
 *                (`workspace:read`) or draft-generation (`workspace:draft`). The
 *                union deliberately has no write/send member, so a conformance
 *                test can prove no built-in mutates workspace state or sends mail.
 *   - `spend`  — the LLM spend-attribution feature tag a tool records under when
 *                it dispatches the model, or `null` when it never calls the LLM.
 *   - `scrubOutput` — whether the host injection-scrubs the tool's output before
 *                it can reach a prompt. Tool output is untrusted text; the host
 *                is the guarantee, independent of what a tool does internally.
 *
 * This module is intentionally free of `'use node'` and of any AI-SDK runtime
 * import: it holds the metadata contract and the pure host helpers (selection +
 * output scrubbing) so they unit-test as plain functions. The executable tool
 * builders and the `ctx`-bound assembler live in `./tools`.
 */

import type { Tool, ToolExecuteFunction } from 'ai';
import type { ActionCtx } from '../_generated/server';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { scrubForInjection } from './prompt';

/**
 * The data-access class of a built-in assistant tool. Read tools return existing
 * workspace data; draft tools synthesize text through a budgeted LLM dispatch.
 * There is intentionally no write or send scope: no assistant tool ever mutates
 * workspace state or sends mail (decision B1), and the conformance suite asserts
 * every built-in stays inside this union.
 */
export type AssistantToolScope = 'workspace:read' | 'workspace:draft';

/**
 * Spend-attribution feature tag shared by the two draft tools. Kept as one
 * constant so a module's `spend` metadata and the tag its builder records under
 * can never drift apart.
 */
export const ASSISTANT_TOOL_DRAFT_SPEND = 'assistant_tool_draft' as const;

/**
 * A hosted assistant tool: its host-enforced metadata plus a builder that closes
 * over the runner's action context to produce the AI-SDK tool. Data-only fields
 * first, executable last — the same shape as the other hosted-module registries.
 */
export interface HostedAssistantToolModule {
	readonly name: string;
	/** When set and OFF at run time, the host omits this tool. Undefined ⇒ always present. */
	readonly flag?: FeatureFlagKey;
	readonly scope: AssistantToolScope;
	/** Feature tag the tool records LLM spend under, or `null` when it never dispatches. */
	readonly spend: string | null;
	/** When true, the host injection-scrubs the tool's output before it reaches the model. */
	readonly scrubOutput: boolean;
	build(ctx: ActionCtx): Tool;
}

/** Resolved feature-flag state as returned by the host's flag resolver. */
export type ResolvedFlags = Readonly<Record<string, boolean>>;

/**
 * Keep only the modules whose flag is enabled (or unset). Ordering is preserved,
 * so the assembled set's iteration order matches the registry's declaration
 * order. Pure so the gate is unit-tested without a Convex context.
 */
export function selectAssistantToolModules(
	modules: readonly HostedAssistantToolModule[],
	flags: ResolvedFlags
): readonly HostedAssistantToolModule[] {
	return modules.filter((module) => !module.flag || flags[module.flag] === true);
}

/** True when any module declares a flag — i.e. the assembler must resolve flags. */
export function hasFlaggedModule(modules: readonly HostedAssistantToolModule[]): boolean {
	return modules.some((module) => module.flag !== undefined);
}

/**
 * Recursively injection-scrub every string in a tool's output. Numbers, booleans,
 * and nulls pass through untouched; each string runs through the same
 * `scrubForInjection` withholding the tool bodies already apply per field, so a
 * string that is already safe (or already withheld) is returned unchanged. This
 * is the host's blanket guarantee that untrusted tool text — from any tool,
 * including future plugin tools that forget to scrub — cannot smuggle
 * instructions into the model.
 */
export function scrubToolOutput(value: unknown): unknown {
	if (typeof value === 'string') return scrubForInjection(value);
	if (Array.isArray(value)) return value.map(scrubToolOutput);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
				key,
				scrubToolOutput(entry),
			])
		);
	}
	return value;
}

/**
 * Wrap a built tool so the host scrubs its output. The wrapper preserves the
 * tool's description and input schema and only interposes on `execute`; a tool
 * with no `execute` (none of the built-ins) is returned unchanged.
 */
export function withHostScrub(built: Tool): Tool {
	const original = built.execute;
	if (typeof original !== 'function') return built;
	const execute: ToolExecuteFunction<unknown, unknown> = async (input, options) =>
		scrubToolOutput(await original(input, options));
	return { ...built, execute } as Tool;
}
