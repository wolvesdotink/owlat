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
 * error leaves the partial text errored.
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
import { buildAssistantTools } from './tools';
import { buildAssistantSystemPrompt, clampText, type AssistantSurface } from './prompt';
import { assistantToolCallValidator } from '../lib/convexValidators';

type ToolCall = Infer<typeof assistantToolCallValidator>;
type Status = 'complete' | 'stopped' | 'error';

/** Min wall-clock between streaming row writes (caps write amplification). */
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
		system: string;
		messages: ModelMessage[];
		lastUserText: string;
		feature: string;
		patch: (text: string, toolCalls: ToolCall[] | undefined) => Promise<{ stop: boolean }>;
		finalize: (args: FinalizeArgs) => Promise<void>;
	}
): Promise<void> {
	const tools = buildAssistantTools(ctx);
	const controller = new AbortController();
	let text = '';
	const toolCalls: ToolCall[] = [];
	let lastFlushAt = 0;
	let stopRequested = false;

	const flush = async (force: boolean): Promise<void> => {
		const now = Date.now();
		if (!force && now - lastFlushAt < FLUSH_INTERVAL_MS) return;
		lastFlushAt = now;
		const res = await opts.patch(text, toolCalls.length ? toolCalls : undefined);
		if (res.stop) {
			stopRequested = true;
			controller.abort();
		}
	};

	try {
		const result = await runLlmStream({
			model: await resolveLanguageModelForUserText(ctx, 'draft', opts.lastUserText),
			system: opts.system,
			messages: opts.messages,
			tools,
			maxSteps: DEFAULT_MAX_TOOL_STEPS,
			temperature: 0.3,
			abortSignal: controller.signal,
			onTextDelta: async (full) => {
				text = full;
				await flush(false);
			},
			onToolCall: async (c) => {
				toolCalls.push({
					toolCallId: c.toolCallId,
					toolName: c.toolName,
					argsJson: safeJson(c.input, MAX_TOOL_ARGS_JSON),
					status: 'running',
				});
				await flush(true);
			},
			onToolResult: async (r) => {
				const tc = toolCalls.find((x) => x.toolCallId === r.toolCallId);
				if (tc) {
					tc.status = 'done';
					tc.resultJson = safeJson(r.output, MAX_TOOL_RESULT_JSON);
				}
				await flush(true);
			},
			onToolError: async (e) => {
				const tc = toolCalls.find((x) => x.toolCallId === e.toolCallId);
				if (tc) {
					tc.status = 'error';
					tc.resultJson = clampText(String(e.error), 500);
				}
				await flush(true);
			},
		});

		await recordLlmSpend(ctx, opts.feature, result.tokenUsage, result.modelUsed);
		await opts.finalize({
			text: result.text || text,
			status: stopRequested || result.aborted ? 'stopped' : 'complete',
			model: result.modelUsed,
			tokenUsage: result.tokenUsage,
			toolCalls: toolCalls.length ? toolCalls : undefined,
		});
	} catch (error) {
		await opts.finalize({
			text,
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
