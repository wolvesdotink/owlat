/**
 * A source message's body fingerprint (review F1): a hash of the STORED body
 * columns (sealed envelopes and storage ids, never plaintext), computable in a
 * query and in a mutation alike. The run reads it with the body it scopes; the
 * reducer recomputes it in its own transaction and refuses the write when the
 * body changed in between, so claims extracted from an older body never
 * commit against a newer one.
 *
 * Flag or folder changes do not move it; only the body columns do.
 */

import type { QueryCtx } from '../../_generated/server';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import { loadStoredInlineBody } from '../../lib/messageBodyStore';
import { inboundMessageBody } from '../../lib/messageBodyInbound';

type ReadCtx = Pick<QueryCtx, 'db'>;

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The fingerprint of the source's stored body, or null when the source is gone. */
export async function sourceVersionOf(
	ctx: ReadCtx,
	source: InterpretationSource
): Promise<string | null> {
	let columns: unknown;
	switch (source.kind) {
		case 'mail':
		case 'outboundMail': {
			const row = await ctx.db.get(source.id);
			if (!row) return null;
			columns = [
				await loadStoredInlineBody(ctx.db, row),
				row.textBodyStorageId ?? null,
				row.htmlBodyStorageId ?? null,
			];
			break;
		}
		case 'inbound': {
			const row = await ctx.db.get(source.id);
			if (!row) return null;
			columns = [inboundMessageBody(row), row.textBodyStorageId ?? null, row.htmlBodyStorageId ?? null];
			break;
		}
		case 'teamReply': {
			const snapshot = await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', interpretationSourceKey(source)))
				.first();
			if (!snapshot?.snapshot) return null;
			columns = [snapshot.snapshot.text, snapshot.snapshot.capturedAt];
			break;
		}
	}
	return (await sha256Hex(JSON.stringify(columns))).slice(0, 32);
}
