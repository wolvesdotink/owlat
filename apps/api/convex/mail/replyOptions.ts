'use node';

/**
 * Shared reply-options generator.
 *
 * Two entry points, one cap and one parser:
 *   - {@link generateReplyOptions}: one capable-tier `runLlmObject` pass. The
 *     inbound agent's `draft` step (via agent/shared/draftService) uses it to
 *     offer the reviewer 2–3 full alternative drafts; nobody waits on it.
 *   - {@link streamReplyOptions}: the Postbox "suggested replies" path
 *     (mail/ai/assist.suggestReplies). A person is watching a spinner here and
 *     the options are 1–2 sentences, so it runs on the fast tier and streams:
 *     the model writes a numbered list, {@link parseReplyOptionsText} turns the
 *     text so far into options, and the throttled flusher writes them into the
 *     caller's owner-private `aiDraftStreams` buffer. The client renders each
 *     option as it arrives instead of waiting 5–20 s for the whole object.
 *
 * Precomputing options during draft-on-arrival was the other way to hide the
 * latency. It was not taken: draft-on-arrival already prepares one full draft
 * for the mail that needs it, and generating options for every arrival would
 * spend tokens on mail nobody asks about.
 *
 * Callers own their prompt framing (the inbound thread body is untrusted DATA in
 * both) and their own spend accounting.
 */

import { z } from 'zod';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { resolveLanguageModel } from '../lib/llmProvider';
import { runLlmObject, runLlmStream } from '../lib/llm/dispatch';
import { createThrottledStreamFlusher } from '../lib/llm/streamFlusher';
import type { TokenUsage } from '../agent/steps/types';

/** Hard cap on how many reply variants we ever surface. */
export const MAX_REPLY_OPTIONS = 3;

/** Structured output: up to {@link MAX_REPLY_OPTIONS} short reply variants. */
const replyOptionsSchema = z.object({
	replies: z.array(z.string()).max(MAX_REPLY_OPTIONS),
});

interface ReplyOptionsResult {
	replies: string[];
	tokenUsage: TokenUsage | undefined;
	modelUsed: string | undefined;
}

/**
 * Run one capable-tier `runLlmObject` pass that returns up to
 * {@link MAX_REPLY_OPTIONS} distinct reply variants for the given prompt.
 * Returns the trimmed replies plus the token usage + model id so the caller can
 * record spend under its own event name. Does NOT record spend or catch errors
 * itself — the caller decides fail-soft behaviour.
 */
export async function generateReplyOptions(
	ctx: ActionCtx,
	args: {
		prompt: string;
		temperature?: number;
		abortSignal?: AbortSignal;
		maxAttempts?: number;
	}
): Promise<ReplyOptionsResult> {
	const { object, tokenUsage, modelUsed } = await runLlmObject({
		model: await resolveLanguageModel(ctx, 'draft'),
		schema: replyOptionsSchema,
		prompt: args.prompt,
		temperature: args.temperature ?? 0.7,
		...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
		...(args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts }),
	});
	return {
		replies: object.replies.slice(0, MAX_REPLY_OPTIONS),
		tokenUsage,
		modelUsed,
	};
}

// ─── Streamed options ────────────────────────────────────────────────────────

/**
 * Output rule appended to a streamed options prompt. A numbered list streams
 * well (each marker opens the next option) and lets an option span lines.
 */
export const REPLY_OPTIONS_LIST_FORMAT =
	`Write each reply as its own numbered item: start it on a new line with ` +
	`"1. ", "2. " or "3. ". Output only the numbered replies, with no heading, ` +
	`labels, commentary or quotation marks around them.`;

/**
 * How often (ms) the parsed options are written to the buffer. Each write is a
 * mutation; options are short, so a slightly coarser beat than revise's 120 ms
 * still shows every option as it forms.
 */
const OPTIONS_FLUSH_INTERVAL_MS = 150;

/** A list marker at the start of a line: `1.` / `2)` followed by a space. */
const LIST_MARKER = /^[ \t]*\d{1,2}[.)][ \t]+/gm;
/** The start of the next marker, still arriving at the end of the stream. */
const TRAILING_PARTIAL_MARKER = /\n[ \t]*\d{0,2}[.)]?[ \t]*$/;

function unquote(text: string): string {
	const t = text.trim();
	const pairs: [string, string][] = [
		['"', '"'],
		['“', '”'],
		["'", "'"],
	];
	for (const [open, close] of pairs) {
		if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) return t.slice(1, -1).trim();
	}
	return t;
}

/**
 * Split the model's numbered-list text (complete or still streaming) into reply
 * options. Anything before the first marker (a "Here are three options:"
 * preamble) is dropped; text with no markers at all counts as ONE reply rather
 * than being guessed apart. With `partial`, the half-written start of the next
 * marker is trimmed off the last option so "…today.\n2" never flashes up.
 * Capped at {@link MAX_REPLY_OPTIONS}; empty options are skipped.
 */
export function parseReplyOptionsText(raw: string, opts: { partial?: boolean } = {}): string[] {
	let text = raw.replace(/\r/g, '');
	if (opts.partial) text = text.replace(TRAILING_PARTIAL_MARKER, '');
	const starts = [...text.matchAll(LIST_MARKER)];
	const bodies =
		starts.length === 0
			? [text]
			: starts.map((m, i) => {
					const from = (m.index ?? 0) + m[0].length;
					const to = i + 1 < starts.length ? (starts[i + 1]!.index ?? text.length) : text.length;
					return text.slice(from, to);
				});
	return bodies
		.map(unquote)
		.filter((r) => r.length > 0)
		.slice(0, MAX_REPLY_OPTIONS);
}

/**
 * Wire format of a suggest buffer's `text`: the options so far as a JSON array.
 * The server owns the parsing; the client only decodes (see the web
 * `useSuggestReplies`). While the buffer is `streaming`, every option but the
 * last is final.
 */
export function encodeReplyOptions(replies: string[]): string {
	return JSON.stringify(replies);
}

/**
 * Stream up to {@link MAX_REPLY_OPTIONS} short reply options on the FAST tier.
 *
 * With a `streamId` the caller must already have proven ownership of the buffer
 * (`draftStreamStore.beginDraftStream`); the parsed options are throttle-written
 * to it and the buffer settles `complete` (or `error`). When the client deletes
 * the buffer (it has what it needs, or the user moved on) the model stream is
 * aborted and the options parsed so far are returned. Without a `streamId` the
 * call still streams internally but writes nothing.
 *
 * Throws on a model failure (after settling the buffer `error`); spend is left
 * to the caller, as with {@link generateReplyOptions}.
 */
export async function streamReplyOptions(
	ctx: ActionCtx,
	args: {
		system: string;
		prompt: string;
		streamId?: Id<'aiDraftStreams'>;
		temperature?: number;
		/** The interactive deadline (`interactiveLlmPolicy('reply').abortSignal`). */
		abortSignal?: AbortSignal;
	}
): Promise<ReplyOptionsResult> {
	const streamId = args.streamId;
	const flusher = createThrottledStreamFlusher({
		intervalMs: OPTIONS_FLUSH_INTERVAL_MS,
		patch: (raw) =>
			streamId
				? ctx.runMutation(internal.mail.draftStreamStore.appendDraftStream, {
						streamId,
						text: encodeReplyOptions(parseReplyOptionsText(raw, { partial: true })),
					})
				: Promise.resolve({ stop: false }),
	});
	const finalize = async (
		replies: string[],
		status: 'complete' | 'error',
		extra: { errorMessage?: string; modelUsed?: string; tokenUsage?: TokenUsage } = {}
	) => {
		if (!streamId) return;
		await ctx.runMutation(internal.mail.draftStreamStore.finalizeDraftStream, {
			streamId,
			text: encodeReplyOptions(replies),
			status,
			...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
			...(extra.modelUsed ? { model: extra.modelUsed } : {}),
			...(extra.tokenUsage ? { tokenUsage: extra.tokenUsage } : {}),
		});
	};

	const abortSignal = args.abortSignal
		? AbortSignal.any([args.abortSignal, flusher.signal])
		: flusher.signal;
	const model = await resolveLanguageModel(ctx, 'suggest');
	try {
		const result = await runLlmStream({
			model,
			system: args.system,
			messages: [{ role: 'user', content: args.prompt }],
			temperature: args.temperature ?? 0.7,
			abortSignal,
			onTextDelta: flusher.onText,
		});
		// A deadline that cut the stream short still returns the options that
		// made it; only a deadline with nothing to show is a failure.
		const replies = parseReplyOptionsText(result.text || flusher.text, {
			partial: result.aborted,
		});
		if (result.aborted && !flusher.stopRequested && replies.length === 0) {
			throw new Error('Suggested replies timed out');
		}
		await finalize(replies, 'complete', {
			...(result.modelUsed ? { modelUsed: result.modelUsed } : {}),
			...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
		});
		return { replies, tokenUsage: result.tokenUsage, modelUsed: result.modelUsed };
	} catch (error) {
		// The client let go of the buffer: not a failure, hand back what arrived.
		if (flusher.stopRequested) {
			return {
				replies: parseReplyOptionsText(flusher.text, { partial: true }),
				tokenUsage: undefined,
				modelUsed: undefined,
			};
		}
		const message = error instanceof Error ? error.message : 'Suggest replies failed';
		// Settling the buffer is best-effort; the model error is what surfaces.
		await finalize([], 'error', { errorMessage: message.slice(0, 500) }).catch(() => undefined);
		throw error;
	}
}
