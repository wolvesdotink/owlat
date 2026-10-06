'use node';

/**
 * Conversation runner — the streaming, tool-calling engine behind the AI
 * assistant. A scheduled Node action (no user identity; the gating mutation that
 * scheduled it already authorized the caller).
 *
 * One shared loop (`streamAssistantTurn`) drives both surfaces: it assembles the
 * model context, runs `runLlmStream` with the assistant tool set, and patches
 * the streaming assistant row in place (throttled row-append) so the reactive
 * subscription renders tokens + tool-call cards as they arrive. Natural finish
 * records spend + marks complete; a user Stop / deletion (detected via the patch
 * mutation's `stop` signal) aborts and leaves the partial text terminal; any
 * error leaves the partial text errored and records the spend of the steps that
 * finished before it (#1261).
 *
 *   run         → personal assistant   (aiConversations / aiMessages)
 *   runForChat  → @assistant in a room (chatMessages)
 */

import { v } from 'convex/values';
import type { Infer } from 'convex/values';
import type { ModelMessage } from 'ai';
import type { ActionCtx } from '../_generated/server';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { runLlmStream, DEFAULT_MAX_TOOL_STEPS } from '../lib/llm/dispatch';
import { resolveLanguageModelForUserText } from '../lib/llmProvider';
import { recordLlmSpend } from '../analytics/llmUsage';
import { partialUsageOf } from '../lib/llm/partialUsage';
import { logWarn } from '../lib/runtimeLog';
import type { TokenUsage } from '../agent/steps/types';
import { createThrottledStreamFlusher } from '../lib/llm/streamFlusher';
import { buildAssistantTools } from './tools';
import type { AssistantAudience } from './toolRegistry';
import { buildAssistantSystemPrompt, clampText, type AssistantSurface } from './prompt';
import { assistantToolCallValidator } from '../lib/convexValidators';

type ToolCall = Infer<typeof assistantToolCallValidator>;
type Status = 'complete' | 'stopped' | 'error';

/**
 * Min wall-clock between streaming row writes. A turn can run for a minute of
 * tool calls and every write re-renders the whole conversation, so this is
 * coarser than the composer's revise stream (mail/ai/reviseDraft.ts).
 */
const FLUSH_INTERVAL_MS = 250;
const MAX_TOOL_RESULT_JSON = 4000;
const MAX_TOOL_ARGS_JSON = 1000;

/** JSON-encode a tool payload for display, clamped to a bounded length. */
function safeJson(value: unknown, max: number): string {
	let s: string;
	try {
		s = JSON.stringify(value) ?? String(value);
	} catch {
		s = String(value);
	}
	return clampText(s, max);
}

function toModelMessage(m: { role: 'user' | 'assistant'; text: string }): ModelMessage {
	return m.role === 'user'
		? { role: 'user', content: m.text }
		: { role: 'assistant', content: m.text };
}

/**
 * Write a turn's spend to the ledger without letting a failed write decide the
 * turn's status: the answer stands (or the original error does) either way.
 */
async function recordTurnSpend(
	ctx: ActionCtx,
	feature: string,
	tokenUsage: TokenUsage | undefined,
	modelUsed: string | undefined
): Promise<void> {
	try {
		await recordLlmSpend(ctx, feature, tokenUsage, modelUsed);
	} catch (error) {
		logWarn('[assistant] spend not recorded:', feature, error);
	}
}

interface FinalizeArgs {
	text: string;
	status: Status;
	model?: string;
	tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
	errorMessage?: string;
	toolCalls?: ToolCall[];
}

/**
 * The shared streaming loop. Surface-specific persistence is injected via
 * `patch` (returns `{ stop }`) and `finalize`; everything else — the stream
 * consumption, throttled flushing, tool-card accumulation, spend, and terminal
 * status selection — is identical for both surfaces.
 */
async function streamAssistantTurn(
	ctx: ActionCtx,
	opts: {
		surface: AssistantSurface;
		audience: AssistantAudience;
		system: string;
		messages: ModelMessage[];
		lastUserText: string;
		feature: string;
		patch: (text: string, toolCalls: ToolCall[] | undefined) => Promise<{ stop: boolean }>;
		finalize: (args: FinalizeArgs) => Promise<void>;
	}
): Promise<void> {
	const tools = await buildAssistantTools(ctx, opts.audience);
	const toolCalls: ToolCall[] = [];
	// Every write carries the tool cards too; a tool event flushes at once.
	const stream = createThrottledStreamFlusher({
		intervalMs: FLUSH_INTERVAL_MS,
		patch: (text) => opts.patch(text, toolCalls.length ? toolCalls : undefined),
	});

	try {
		const result = await runLlmStream({
			model: await resolveLanguageModelForUserText(ctx, 'draft', opts.lastUserText),
			system: opts.system,
			messages: opts.messages,
			tools,
			maxSteps: DEFAULT_MAX_TOOL_STEPS,
			temperature: 0.3,
			abortSignal: stream.signal,
			onTextDelta: stream.onText,
			onToolCall: async (c) => {
				toolCalls.push({
					toolCallId: c.toolCallId,
					toolName: c.toolName,
					argsJson: safeJson(c.input, MAX_TOOL_ARGS_JSON),
					status: 'running',
				});
				await stream.flush(true);
			},
			onToolResult: async (r) => {
				const tc = toolCalls.find((x) => x.toolCallId === r.toolCallId);
				if (tc) {
					tc.status = 'done';
					tc.resultJson = safeJson(r.output, MAX_TOOL_RESULT_JSON);
				}
				await stream.flush(true);
			},
			onToolError: async (e) => {
				const tc = toolCalls.find((x) => x.toolCallId === e.toolCallId);
				if (tc) {
					tc.status = 'error';
					tc.resultJson = clampText(String(e.error), 500);
				}
				await stream.flush(true);
			},
		});

		await recordTurnSpend(ctx, opts.feature, result.tokenUsage, result.modelUsed);
		await opts.finalize({
			text: result.text || stream.text,
			status: stream.stopRequested || result.aborted ? 'stopped' : 'complete',
			model: result.modelUsed,
			tokenUsage: result.tokenUsage,
			toolCalls: toolCalls.length ? toolCalls : undefined,
		});
	} catch (error) {
		// Steps that finished before the failure were billed. Only the stream's
		// own error carries them, so a finalize failure above never records twice.
		const partial = partialUsageOf(error);
		if (partial) await recordTurnSpend(ctx, opts.feature, partial.tokenUsage, partial.modelUsed);
		await opts.finalize({
			text: stream.text,
			status: 'error',
			errorMessage: clampText(String((error as { message?: unknown })?.message ?? error), 300),
			toolCalls: toolCalls.length ? toolCalls : undefined,
		});
	}
}

/** Personal assistant — drive a `/dashboard/assistant` conversation turn. */
export const run = internalAction({
	args: {
		conversationId: v.id('aiConversations'),
		assistantMessageId: v.id('aiMessages'),
		ownerId: v.string(),
		// Whether the owner could read the Team Inbox when they sent the turn.
		// Optional so a turn scheduled before this field existed still runs;
		// absent counts as not a reader.
		includeInboxDerived: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const runCtx = await ctx.runQuery(internal.assistant.conversations.getRunContext, {
			conversationId: args.conversationId,
			assistantMessageId: args.assistantMessageId,
		});
		if (!runCtx || runCtx.messages.length === 0) {
			await ctx.runMutation(internal.assistant.conversations.finalizeAssistantMessage, {
				messageId: args.assistantMessageId,
				text: '',
				status: 'error',
				errorMessage: 'The conversation context could not be loaded.',
			});
			return;
		}
		const lastUser = [...runCtx.messages].reverse().find((m) => m.role === 'user');
		await streamAssistantTurn(ctx, {
			surface: 'personal',
			audience: { canReadInbox: args.includeInboxDerived === true },
			system: buildAssistantSystemPrompt({ surface: 'personal', userName: runCtx.userName }),
			messages: runCtx.messages.map(toModelMessage),
			lastUserText: lastUser?.text ?? '',
			feature: 'assistant_chat',
			patch: (text, toolCalls) =>
				ctx.runMutation(internal.assistant.conversations.patchAssistantMessage, {
					messageId: args.assistantMessageId,
					text,
					toolCalls,
				}),
			finalize: async (a) => {
				await ctx.runMutation(internal.assistant.conversations.finalizeAssistantMessage, {
					messageId: args.assistantMessageId,
					...a,
				});
			},
		});
	},
});

/** @assistant in team chat — drive a streamed reply visible to the whole room. */
export const runForChat = internalAction({
	args: {
		roomId: v.id('chatRooms'),
		assistantMessageId: v.id('chatMessages'),
		promptMessageId: v.id('chatMessages'),
	},
	handler: async (ctx, args) => {
		const runCtx = await ctx.runQuery(internal.chat.messages.getAssistantChatContext, {
			roomId: args.roomId,
			assistantMessageId: args.assistantMessageId,
		});
		if (!runCtx || runCtx.messages.length === 0) {
			await ctx.runMutation(internal.chat.messages.finalizeAssistantChatMessage, {
				messageId: args.assistantMessageId,
				text: '',
				status: 'error',
			});
			return;
		}
		const lastUser = [...runCtx.messages].reverse().find((m) => m.role === 'user');
		await streamAssistantTurn(ctx, {
			surface: 'chat',
			// The reply is visible to the whole room.
			audience: { canReadInbox: false },
			system: buildAssistantSystemPrompt({ surface: 'chat', roomName: runCtx.roomName }),
			messages: runCtx.messages.map(toModelMessage),
			lastUserText: lastUser?.text ?? '',
			feature: 'chat_assistant',
			patch: (text, toolCalls) =>
				ctx.runMutation(internal.chat.messages.patchAssistantChatMessage, {
					messageId: args.assistantMessageId,
					text,
					toolCalls,
				}),
			finalize: async (a) => {
				await ctx.runMutation(internal.chat.messages.finalizeAssistantChatMessage, {
					messageId: args.assistantMessageId,
					...a,
				});
			},
		});
	},
});
