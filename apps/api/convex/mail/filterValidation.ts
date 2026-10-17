/**
 * Read on arrival (SPEC §6.1, §6.2): the server-side check every filter passes
 * on its way into `mailFilters`, at every boundary that writes one: create,
 * update, the Gmail import and a confirmed plain-language or Fix compile.
 *
 * Two families of filter:
 *
 *   - MANUAL deterministic filters (origin absent or `manual`, no AI
 *     condition) keep today's full action set: move, label, read, flag,
 *     section, forward, delete, discard. They run in the hosted pre-insert
 *     pass (`deliveryPipeline/routing.ts`). The read-on-arrival actions are
 *     not theirs: that pass does not run them, so a manual filter may not
 *     carry one.
 *   - HOOK filters (a plain-language or Fix origin, or an AI condition) run in
 *     the arrival hook (`mail/arrival/rulesPass.ts`) and are restrict-only:
 *     nothing they do is irreversible, so nothing can run before or after a
 *     pending AI answer that a person could not undo. They may not use
 *     `header` conditions (the evaluator never sees headers), may not move to
 *     Trash, Spam, Sent or Drafts, and an AI-conditioned one may not stop
 *     processing (its late answer must not change what any other filter
 *     does).
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { throwInvalidInput } from '../_utils/errors';

type FilterRow = Doc<'mailFilters'>;
type FilterAction = FilterRow['actions'][number];
type FilterCondition = FilterRow['conditions'][number];

/** Hours an `archiveAfter` action may wait (§6.3). */
export const ARCHIVE_AFTER_HOURS = { min: 1, max: 720 } as const;

/** Longest AI question a rule may ask; R2 cuts each question at this length too. */
export const MAX_AI_QUESTION_CHARS = 300;

/** What a manual deterministic filter may do: today's full set. */
const MANUAL_ACTION_TYPES: ReadonlySet<FilterAction['type']> = new Set([
	'moveToFolder',
	'addLabel',
	'markRead',
	'markFlagged',
	'forward',
	'delete',
	'pinToSection',
	'discard',
]);

/** What a plain-language, Fix or AI-conditioned filter may do: restrict-only (§6.1). */
const HOOK_ACTION_TYPES: ReadonlySet<FilterAction['type']> = new Set([
	'addLabel',
	'moveToFolder',
	'markRead',
	'markFlagged',
	'pinToSection',
	'sendToDigest',
	'placeInUpdates',
	'placeInNeedsMe',
	'archiveAfter',
	'notify',
]);

/** Folder roles a hook filter may never file into. */
const FORBIDDEN_TARGET_ROLES: ReadonlySet<string> = new Set(['trash', 'spam', 'sent', 'drafts']);

/** Role-less folders (mirrored from a provider) whose name says Trash or Junk. */
const FORBIDDEN_TARGET_NAME =
	/^(?:junk|junk[ -]?e-?mail|bulk mail|spam|trash|bin|deleted(?: items| messages)?|papierkorb)$/i;

/** Runs in the arrival hook rather than the manual pre-insert pass (§6.2). */
export function isHookFilter(filter: {
	origin?: FilterRow['origin'];
	aiCondition?: { question: string } | undefined;
}): boolean {
	return (filter.origin !== undefined && filter.origin !== 'manual') || !!filter.aiCondition;
}

/** The shape a save boundary checks. */
export interface FilterForSave {
	origin?: FilterRow['origin'];
	aiCondition?: { question: string } | undefined;
	conditions: FilterCondition[];
	actions: FilterAction[];
	stopProcessing: boolean;
}

function checkHookShape(filter: FilterForSave): void {
	if (filter.aiCondition) {
		const question = filter.aiCondition.question.trim();
		if (!question) throwInvalidInput('An AI condition needs a question');
		if (question.length > MAX_AI_QUESTION_CHARS) throwInvalidInput('The AI question is too long');
		if (filter.stopProcessing) {
			throwInvalidInput('A rule with an AI condition cannot stop later rules');
		}
	} else if (filter.conditions.length === 0) {
		throwInvalidInput('At least one condition is required');
	}
	if (filter.conditions.some((condition) => condition.field === 'header')) {
		throwInvalidInput('Plain-language and AI rules cannot match on headers');
	}
	let notifyCount = 0;
	for (const action of filter.actions) {
		if (!HOOK_ACTION_TYPES.has(action.type)) {
			throwInvalidInput(`A plain-language or AI rule cannot use the action ${action.type}`);
		}
		if (action.type === 'archiveAfter') {
			const hours = action.hours;
			if (
				hours === undefined ||
				!Number.isInteger(hours) ||
				hours < ARCHIVE_AFTER_HOURS.min ||
				hours > ARCHIVE_AFTER_HOURS.max
			) {
				throwInvalidInput('archiveAfter needs a whole number of hours from 1 to 720');
			}
		}
		if (action.type === 'notify' && ++notifyCount > 1) {
			throwInvalidInput('A rule notifies once');
		}
	}
}

function checkManualShape(filter: FilterForSave): void {
	if (filter.conditions.length === 0) throwInvalidInput('At least one condition is required');
	for (const action of filter.actions) {
		if (!MANUAL_ACTION_TYPES.has(action.type)) {
			throwInvalidInput(`The action ${action.type} needs a plain-language rule`);
		}
	}
}

/** Whether a folder may be a hook filter's move target. Pure. */
export function isAllowedHookTarget(folder: Pick<Doc<'mailFolders'>, 'role' | 'name'>): boolean {
	if (folder.role !== undefined) return !FORBIDDEN_TARGET_ROLES.has(folder.role);
	return !FORBIDDEN_TARGET_NAME.test(folder.name.trim());
}

/**
 * Check one filter before it is written; throws `invalid_input`. Every folder
 * and label an action names must belong to `mailboxId`; a hook filter's move
 * target must not be Trash, Spam, Sent or Drafts.
 */
export async function validateFilterForSave(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	filter: FilterForSave
): Promise<void> {
	if (filter.actions.length === 0) throwInvalidInput('At least one action is required');
	const isHook = isHookFilter(filter);
	if (isHook) checkHookShape(filter);
	else checkManualShape(filter);
	for (const action of filter.actions) {
		// A manual filter keeps today's leniency (an unset target is a no-op).
		if (isHook && action.type === 'moveToFolder' && !action.folderId) {
			throwInvalidInput('moveToFolder action needs a folder');
		}
		if (isHook && action.type === 'addLabel' && !action.labelId) {
			throwInvalidInput('addLabel action needs a label');
		}
		if (action.folderId) {
			const folder = await ctx.db.get(action.folderId);
			if (!folder || folder.mailboxId !== mailboxId) {
				throwInvalidInput('moveToFolder action references unknown folder');
			}
			if (isHook && !isAllowedHookTarget(folder)) {
				throwInvalidInput('A plain-language or AI rule cannot file mail into that folder');
			}
		}
		if (action.labelId) {
			const label = await ctx.db.get(action.labelId);
			if (!label || label.mailboxId !== mailboxId) {
				throwInvalidInput('addLabel action references unknown label');
			}
		}
	}
}
