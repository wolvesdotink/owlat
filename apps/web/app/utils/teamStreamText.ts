/**
 * The words of a team stream system line (plan §4.3): who did what to which
 * action, from the activity row alone. Pure: the caller passes `t` and how to
 * name a teammate.
 */
import type { ActivityEntry } from '~/utils/teamStream';

type Translate = (key: string, params?: Record<string, unknown>, plural?: number) => string;

/** Activity types whose line names the action it is about. */
const ITEM_TYPES = new Set([
	'item_opened',
	'item_closed',
	'item_reopened',
	'item_replaced',
	'item_changed',
	'item_corrected',
	'proposal_confirmed',
]);

/** Who did it, when a person or Owlat did; null when the line reads without one. */
export function actorLabel(
	entry: ActivityEntry,
	opts: { t: Translate; memberName: (userId: string) => string }
): string | null {
	const actor = entry.activity.actor;
	if (actor.kind === 'user') return actor.id ? opts.memberName(actor.id) : null;
	if (actor.kind === 'agent') return opts.t('dashboard.inbox.detail.outbound.agent');
	return null;
}

/** The sentence of one line; several new actions noted together read as one. */
export function systemLineText(
	entries: readonly ActivityEntry[],
	opts: { t: Translate; memberName: (userId: string) => string }
): string {
	const { t } = opts;
	const first = entries[0];
	if (!first) return '';
	const type = first.activity.type;
	if (type === 'item_opened' && entries.length > 1) {
		return t('components.team.stream.system.openedMany', { count: entries.length }, entries.length);
	}
	let sentence: string;
	if (ITEM_TYPES.has(type) && first.itemText) {
		const status = first.activity.delta?.statusTo;
		const key =
			type === 'item_closed' && status && status !== 'done' ? `item_closed_${status}` : type;
		sentence = t(`components.team.stream.system.${key}`, { item: first.itemText });
	} else {
		sentence = first.activity.text?.trim() || t(`components.brief.activity.type.${type}`);
	}
	const actor = actorLabel(first, opts);
	return actor ? `${actor} · ${sentence}` : sentence;
}
