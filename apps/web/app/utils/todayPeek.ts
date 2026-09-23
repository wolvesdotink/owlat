import type { InjectionKey } from 'vue';
import type { TodaySource } from './todayDigest';

/**
 * Today's side panel ("peek"): opening a summarised phrase shows its source
 * email over Today without leaving the page. The panel state lives in the URL
 * (`?peek=mail:<messageId>` / `?peek=team:<inboundMessageId>`) so Back closes
 * it and the link can be shared; the list of sources behind the phrase is kept
 * alongside so ↑/↓ can step through them.
 */
export interface TodayPeekControls {
	open(sources: TodaySource[], index?: number): void;
	openThread(source: TodaySource): void;
}

export const TODAY_PEEK: InjectionKey<TodayPeekControls> = Symbol('today-peek');

export function peekKey(source: Pick<TodaySource, 'kind' | 'id'>): string {
	return `${source.kind}:${source.id}`;
}

export function parsePeekKey(raw: unknown): { kind: 'mail' | 'team'; id: string } | null {
	if (typeof raw !== 'string') return null;
	const [kind, id] = raw.split(':', 2);
	if ((kind !== 'mail' && kind !== 'team') || !id) return null;
	return { kind, id };
}

/** Where a source's full conversation lives. */
export function threadHref(source: TodaySource): string {
	if (source.kind === 'team') return `/dashboard/inbox/${source.threadId}`;
	return `/dashboard/postbox/inbox/${source.id}${source.mailboxId ? `?mailbox=${source.mailboxId}` : ''}`;
}
