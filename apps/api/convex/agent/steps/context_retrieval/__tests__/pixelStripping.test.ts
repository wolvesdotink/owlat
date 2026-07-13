/**
 * Inbound tracker-privacy: remote images / tracking pixels are neutralized in
 * the body the agent pipeline assembles as LLM context.
 *
 * The agent reads EVERY inbound automatically. An HTML-only message (no
 * text/plain part) whose body reached the model verbatim would carry live
 * remote-image URLs — merely assembling them into the briefing is a privacy
 * hazard and a remote-resource-resolution vector. `inboundBodyForContext`
 * strips remote images (keeping inline `data:`/`cid:` content); the full
 * `contextRetrievalStep.execute` briefing never carries a remote pixel src.
 * Convex query/action/mutation seams are mocked — no live backend, no network.
 */

import { describe, it, expect } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Id } from '../../../../_generated/dataModel';
import { contextRetrievalStep, inboundBodyForContext } from '../index';

const messageId = 'msg_pixel' as Id<'inboundMessages'>;
const input = { inboundMessageId: messageId };

const REMOTE_PIXEL = '<img src="https://tracker.evil/open.gif?u=abc" width="1" height="1" alt="">';
const INLINE_CID = '<img src="cid:logo@corp" alt="logo">';

/** Minimal ctx serving an HTML-only inbound; retrieval legs return empty. */
function makeCtx(message: Record<string, unknown>) {
	return {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getMessage')) return message;
			if (name.includes('getContact')) return null;
			if (name.includes('getRecentActivities')) return [];
			if (name.includes('getThreadMessages')) return [];
			if (name.includes('isGraphRetrievalEnabled')) return false;
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runAction: async () => [],
		runMutation: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('recordContextTier')) return null;
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof contextRetrievalStep.execute>[0];
}

describe('inboundBodyForContext', () => {
	it('strips a remote tracking pixel from an HTML-only body', async () => {
		const body = await inboundBodyForContext({
			textBody: null,
			htmlBody: `<p>Hello</p>${REMOTE_PIXEL}`,
		});
		expect(body).toContain('<p>Hello</p>');
		expect(body).not.toContain('tracker.evil');
		expect(body).not.toContain('<img');
	});

	it('keeps inline cid: content while stripping remote images', async () => {
		const body = await inboundBodyForContext({
			textBody: null,
			htmlBody: `${INLINE_CID}${REMOTE_PIXEL}`,
		});
		expect(body).toContain('cid:logo@corp');
		expect(body).not.toContain('tracker.evil');
	});

	it('prefers the plain-text part verbatim (no images to strip)', async () => {
		const body = await inboundBodyForContext({
			textBody: 'Plain text body',
			htmlBody: REMOTE_PIXEL,
		});
		expect(body).toBe('Plain text body');
	});

	it('returns undefined when neither body part is present', async () => {
		expect(await inboundBodyForContext({ textBody: null, htmlBody: null })).toBeUndefined();
	});
});

describe('contextRetrievalStep.execute — inbound remote-resource neutralization', () => {
	it('does not carry a remote pixel src into the assembled briefing', async () => {
		const ctx = makeCtx({
			from: 'sender@example.com',
			to: 'me@hl.camp',
			subject: 'Newsletter',
			// HTML-only: no text/plain part, so the HTML body is what reaches context.
			htmlBody: `<p>Weekly update</p>${INLINE_CID}${REMOTE_PIXEL}`,
			receivedAt: Date.now(),
		});

		const { output } = await contextRetrievalStep.execute(ctx, input);

		// The remote pixel URL never reaches the model context...
		expect(output.context).not.toContain('tracker.evil');
		// ...while real, inline, and non-image content survives.
		expect(output.context).toContain('Weekly update');
		expect(output.context).toContain('cid:logo@corp');
	});
});
