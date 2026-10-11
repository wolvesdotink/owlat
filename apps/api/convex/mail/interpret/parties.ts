/**
 * An item's parties as the brief keys them: who is responsible (us / them /
 * unclear) and the other side's address for cross-thread items. Pure.
 */

import { normalizeEmail } from '@owlat/shared';
import type { ReduceItem } from './reduceInput';

/** How an item proposal's responsible party reads as a responsibility. */
export function responsibilityOf(responsible: {
	email?: string;
	name?: string;
	isUs: boolean;
}): 'us' | 'them' | 'unclear' {
	if (responsible.isUs) return 'us';
	if (responsible.email || responsible.name) return 'them';
	return 'unclear';
}

/** The counterparty of an item (P4 cross-thread key): the other side's address. */
export function counterpartyKeyOf(
	item: Pick<ReduceItem, 'requester' | 'responsible'>
): string | undefined {
	const other = !item.requester.isUs
		? item.requester.email
		: !item.responsible.isUs
			? item.responsible.email
			: undefined;
	return other ? normalizeEmail(other) : undefined;
}
