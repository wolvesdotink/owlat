/**
 * "Your data" (idea 67) — what Owlat keeps, for how long, and the one horizon
 * the user can change.
 *
 * Two things live here, both pure so the card can be tested without mounting a
 * Convex-backed page:
 *
 *  - the trash auto-purge preference (`mailUserSettings.trashAutoPurgeDays`):
 *    a CLOSED set of horizons, defaulting to Never, which is exactly the
 *    behaviour every mailbox had before the setting existed;
 *  - {@link dataRetentionStatements}, the plain-language list the card renders.
 *    Every line is a `{key, params}` pair — module scope cannot call `useI18n` —
 *    and every number in it comes from `@owlat/shared/retentionHorizons`, the
 *    same constants the sweeps enforce, so the card cannot promise a horizon
 *    the deployment does not keep.
 */

import {
	DELIVERABILITY_COMPLETED_RETENTION_DAYS,
	DELIVERABILITY_EVIDENCE_RETENTION_DAYS,
} from '@owlat/shared/retentionHorizons';

/** Horizons the trash auto-purge control offers. `0` is "Never". */
export type PostboxTrashAutoPurgeDays = 0 | 7 | 30 | 90;

/**
 * Never — and so is an ABSENT setting. Owlat has never auto-emptied a bin, and
 * a user who has not chosen keeps that behaviour.
 */
export const POSTBOX_TRASH_AUTO_PURGE_DEFAULT: PostboxTrashAutoPurgeDays = 0;

const TRASH_AUTO_PURGE_VALUES: readonly number[] = [0, 7, 30, 90];

/** Normalise a stored/unknown value, defaulting to Never. */
export function resolvePostboxTrashAutoPurgeDays(
	value: number | undefined | null
): PostboxTrashAutoPurgeDays {
	return value !== undefined && value !== null && TRASH_AUTO_PURGE_VALUES.includes(value)
		? (value as PostboxTrashAutoPurgeDays)
		: POSTBOX_TRASH_AUTO_PURGE_DEFAULT;
}

/** Picker options; `label` is a catalog key resolved at the render boundary. */
export const POSTBOX_TRASH_AUTO_PURGE_OPTIONS: Array<{
	value: PostboxTrashAutoPurgeDays;
	label: string;
}> = [
	{ value: 0, label: 'shared.postboxTrashAutoPurge.never' },
	{ value: 7, label: 'shared.postboxTrashAutoPurge.days7' },
	{ value: 30, label: 'shared.postboxTrashAutoPurge.days30' },
	{ value: 90, label: 'shared.postboxTrashAutoPurge.days90' },
];

/** One line of the "Your data" card. */
export interface DataRetentionStatement {
	id: 'trash' | 'spam' | 'deliverabilityEvidence' | 'deliverabilityCompleted' | 'mail';
	/** Catalog key for the resource's name. */
	labelKey: string;
	/** Catalog key for what happens to it, with `params` filled in. */
	valueKey: string;
	params?: Record<string, number>;
}

/**
 * What this deployment keeps, in the order a worried user asks about it.
 *
 * Trash and Spam are stated FIRST because they are the two folders people
 * assume empty themselves. They do not: everything Owlat holds is held until
 * the owner deletes it, except the deliverability evidence below and — only if
 * the owner turned it on — trash past their chosen horizon. Saying so plainly
 * is the whole point of the card.
 */
export function dataRetentionStatements(
	trashAutoPurgeDays: PostboxTrashAutoPurgeDays
): DataRetentionStatement[] {
	return [
		{
			id: 'mail',
			labelKey: 'shared.dataRetention.mailLabel',
			valueKey: 'shared.dataRetention.keptUntilDeleted',
		},
		{
			id: 'trash',
			labelKey: 'shared.dataRetention.trashLabel',
			...(trashAutoPurgeDays > 0
				? {
						valueKey: 'shared.dataRetention.trashPurgedAfter',
						params: { days: trashAutoPurgeDays },
					}
				: { valueKey: 'shared.dataRetention.keptUntilDeleted' }),
		},
		{
			id: 'spam',
			labelKey: 'shared.dataRetention.spamLabel',
			valueKey: 'shared.dataRetention.keptUntilDeleted',
		},
		{
			id: 'deliverabilityEvidence',
			labelKey: 'shared.dataRetention.deliverabilityEvidenceLabel',
			valueKey: 'shared.dataRetention.keptForDays',
			params: { days: DELIVERABILITY_EVIDENCE_RETENTION_DAYS },
		},
		{
			id: 'deliverabilityCompleted',
			labelKey: 'shared.dataRetention.deliverabilityCompletedLabel',
			valueKey: 'shared.dataRetention.keptForDays',
			params: { days: DELIVERABILITY_COMPLETED_RETENTION_DAYS },
		},
	];
}
