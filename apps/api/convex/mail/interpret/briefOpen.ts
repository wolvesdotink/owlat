/**
 * Opening sealed item parts for the brief view (`briefRead.ts`): quotes, and a
 * held update with its wording in the reader's locale.
 */

import type { Doc } from '../../_generated/dataModel';
import type { AppLocale } from '@owlat/shared/appLocales';
import type { Evidence } from '../../lib/validators/threadBrief';
import { openMessageBody } from '../../lib/messageBody';
import type { EvidenceView } from './briefShape';
import type { OpenedItem } from './briefProject';

export async function openEvidence(evidence: readonly Evidence[]): Promise<EvidenceView[]> {
	return Promise.all(
		evidence.map(async ({ quote, ...rest }) => ({
			...rest,
			...(quote !== undefined ? { quote: await openMessageBody(quote) } : {}),
		}))
	);
}

/** A held update as the brief shows it: quotes and wording opened, sources left out. */
export async function openHeld(
	held: NonNullable<Doc<'threadItems'>['pendingUpdate']>,
	locale: AppLocale
): Promise<NonNullable<OpenedItem['pendingUpdate']>> {
	const {
		evidence,
		assertion: _assertion,
		display,
		transitions,
		fieldSources: _sources,
		...fields
	} = held;
	return {
		...fields,
		evidence: await openEvidence(evidence),
		...(display ? { text: await openMessageBody(display[locale]) } : {}),
		...(transitions
			? {
					transitions: transitions.map((t) => ({
						...(t.to ? { to: t.to } : {}),
						...(t.disposition ? { disposition: t.disposition } : {}),
						at: t.at,
					})),
				}
			: {}),
	};
}
