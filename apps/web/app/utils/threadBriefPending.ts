/**
 * Every change a held update would make to an item, as the lines the brief
 * shows before Confirm (SPEC §4 "held"): wording, parties, who does it, due
 * date, amount, choices (old → new) and the values the newer reading removes.
 * Confirm applies exactly these, so none may be left out. Pure; the caller
 * passes `t` and the locale.
 */
import type { BriefItemView } from '../../../api/convex/mail/interpret/briefShape';
import { briefDueDate } from '~/utils/threadBriefContext';
import { formatAmount } from '~/utils/threadBriefFacts';

type Translate = (key: string, params?: Record<string, unknown>) => string;
type Update = NonNullable<BriefItemView['pendingUpdate']>;
type Party = BriefItemView['requester'];

function partyName(party: Party | undefined, t: Translate): string {
	if (!party) return t('components.brief.item.pending.nobody');
	return (
		party.name ||
		party.email ||
		t(party.isUs ? 'components.brief.item.pending.us' : 'components.brief.item.pending.nobody')
	);
}

function change(t: Translate, field: string, from: string | null, to: string): string {
	const name = t(`components.brief.item.pending.field.${field}`);
	return from !== null && from !== to ? `${name}: ${from} → ${to}` : `${name}: ${to}`;
}

export function pendingChangeLines(
	item: Pick<
		BriefItemView,
		| 'text'
		| 'requester'
		| 'responsible'
		| 'beneficiary'
		| 'responsibility'
		| 'due'
		| 'amount'
		| 'options'
	> | null,
	update: Update,
	opts: { t: Translate; locale: string }
): string[] {
	const { t, locale } = opts;
	const out: string[] = [];
	const dueText = (due: NonNullable<Update['due']>) =>
		due.at !== undefined ? briefDueDate(due.at, locale) : due.phrase;
	if (update.text !== undefined && update.text !== item?.text) {
		out.push(change(t, 'text', item ? `“${item.text}”` : null, `“${update.text}”`));
	}
	for (const field of ['requester', 'responsible', 'beneficiary'] as const) {
		const next = update[field];
		if (next === undefined) continue;
		out.push(change(t, field, item ? partyName(item[field], t) : null, partyName(next, t)));
	}
	if (update.responsibility !== undefined && update.responsibility !== item?.responsibility) {
		const label = (r: string) => t(`components.brief.item.pending.responsibility.${r}`);
		out.push(
			change(
				t,
				'responsibility',
				item ? label(item.responsibility) : null,
				label(update.responsibility)
			)
		);
	}
	if (update.due) {
		out.push(change(t, 'due', item?.due ? dueText(item.due) : null, dueText(update.due)));
	}
	if (update.amount) {
		const money = (a: NonNullable<Update['amount']>) => formatAmount(a.value, a.currency, locale);
		out.push(change(t, 'amount', item?.amount ? money(item.amount) : null, money(update.amount)));
	}
	if (update.options?.length) {
		out.push(
			change(
				t,
				'options',
				item?.options?.length ? item.options.join(' / ') : null,
				update.options.join(' / ')
			)
		);
	}
	if (update.removes?.length) {
		out.push(
			t('components.brief.item.pending.removed', {
				fields: update.removes.map((f) => t(`components.brief.item.pending.field.${f}`)).join(', '),
			})
		);
	}
	return out;
}
