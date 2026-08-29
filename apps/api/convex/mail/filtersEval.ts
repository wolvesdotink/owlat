/**
 * The pure filter EVALUATOR — the half of `mail/filters.ts` that has no `ctx`.
 *
 * Split out of that module purely for size (CONVENTIONS.md's ~500 LOC cap);
 * `./filters` re-exports every name here, so the delivery pipeline, the dry-run
 * preview and the retroactive sweep keep importing from one place and can never
 * disagree about what a rule means.
 *
 * NO `eval`, no shell-out: the dispatcher below is pure JS over a fixed
 * allowlist of operators.
 */

import type { Doc, Id } from '../_generated/dataModel';
import { openMailMessageInlineBody } from '../lib/messageBody';

export interface EvalMessage {
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	bodyText?: string;
	bodyHtml?: string;
	headers?: Record<string, string | undefined>;
	size: number;
	hasAttachment: boolean;
}

export interface EvalResultAction {
	type:
		| 'moveToFolder'
		| 'addLabel'
		| 'markRead'
		| 'markFlagged'
		| 'forward'
		| 'delete'
		| 'pinToSection'
		| 'discard';
	folderId?: Id<'mailFolders'>;
	labelId?: Id<'mailLabels'>;
	forwardTo?: string;
	sectionName?: string;
}

export interface EvalResult {
	matchedFilterIds: Id<'mailFilters'>[];
	actions: EvalResultAction[];
	stopped: boolean;
}

function fieldValue(message: EvalMessage, field: string, headerName?: string): unknown {
	switch (field) {
		case 'from':
			return message.from.toLowerCase();
		case 'to':
			return message.to.join(' ').toLowerCase();
		case 'cc':
			return message.cc.join(' ').toLowerCase();
		case 'subject':
			return (message.subject ?? '').toLowerCase();
		case 'body':
			return ((message.bodyText ?? '') + ' ' + (message.bodyHtml ?? '')).toLowerCase();
		case 'header':
			if (!headerName) return '';
			return (message.headers?.[headerName.toLowerCase()] ?? '').toLowerCase();
		case 'size':
			return message.size;
		case 'hasAttachment':
			return message.hasAttachment;
		default:
			return '';
	}
}

function compileRegex(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern, 'i');
	} catch {
		return null;
	}
}

function conditionMatches(
	condition: Doc<'mailFilters'>['conditions'][number],
	message: EvalMessage
): boolean {
	const lhs = fieldValue(message, condition.field, condition.headerName);
	const value = (condition.value ?? '').toLowerCase();
	switch (condition.op) {
		case 'contains':
			return typeof lhs === 'string' && value.length > 0 && lhs.includes(value);
		case 'notContains':
			return typeof lhs === 'string' && (value.length === 0 || !lhs.includes(value));
		case 'equals':
			return typeof lhs === 'string' && lhs === value;
		case 'matches': {
			if (typeof lhs !== 'string') return false;
			const re = compileRegex(condition.value ?? '');
			return re ? re.test(lhs) : false;
		}
		case 'greaterThan':
			return typeof lhs === 'number' && lhs > (condition.valueNumber ?? 0);
		case 'lessThan':
			return typeof lhs === 'number' && lhs < (condition.valueNumber ?? 0);
		case 'isTrue':
			return Boolean(lhs);
		default:
			return false;
	}
}

/**
 * Does one filter's condition group match?
 *
 * The one place `matchType` is interpreted, so the delivery pipeline, the
 * dry-run preview and the run-on-existing-mail sweep can never disagree about
 * what a rule means. `matchType` absent is `all`, which is what every filter
 * written before the toggle meant.
 *
 * A filter with no conditions matches NOTHING — under `any` an empty group
 * would otherwise vacuously match every message in the mailbox.
 */
export function filterConditionsMatch(
	filter: Pick<Doc<'mailFilters'>, 'conditions' | 'matchType'>,
	message: EvalMessage
): boolean {
	if (filter.conditions.length === 0) return false;
	return filter.matchType === 'any'
		? filter.conditions.some((c) => conditionMatches(c, message))
		: filter.conditions.every((c) => conditionMatches(c, message));
}

/**
 * Project a stored message row onto the evaluator's input.
 *
 * ASYNC because the inline body columns are SEALED at rest (E8b): matching a
 * `body:` condition against the sealed bytes would silently never fire, so the
 * row goes through `openMailMessageInlineBody` rather than being read directly.
 *
 * The stored row has no raw headers (they live inside the .eml blob), so
 * `header:` conditions see an empty map and simply do not match — which is the
 * honest answer for a retroactive run, not a silent claim that they did.
 */
export async function evalMessageFromRow(
	message: Pick<
		Doc<'mailMessages'>,
		| 'fromAddress'
		| 'toAddresses'
		| 'ccAddresses'
		| 'subject'
		| 'snippet'
		| 'textBodyInline'
		| 'htmlBodyInline'
		| 'rawSize'
		| 'hasAttachments'
	>
): Promise<EvalMessage> {
	const body = await openMailMessageInlineBody(message);
	return {
		from: message.fromAddress,
		to: message.toAddresses,
		cc: message.ccAddresses,
		subject: message.subject,
		// Falls back to the snippet when the body was blobbed out of the row, so
		// `body:` still has something true to match rather than nothing at all.
		bodyText: body.text ?? message.snippet,
		bodyHtml: body.html,
		size: message.rawSize,
		hasAttachment: message.hasAttachments,
	};
}

/**
 * Evaluate a filter list against an inbound message. Pure function — safe
 * to call from inside an internalMutation.
 */
export function evaluateFilters(filters: Doc<'mailFilters'>[], message: EvalMessage): EvalResult {
	const ordered = [...filters].filter((f) => f.isEnabled).sort((a, b) => a.priority - b.priority);

	const matched: Id<'mailFilters'>[] = [];
	const actions: EvalResultAction[] = [];
	let stopped = false;

	for (const filter of ordered) {
		if (!filterConditionsMatch(filter, message)) continue;

		matched.push(filter._id);
		for (const action of filter.actions) {
			actions.push({
				type: action.type,
				folderId: action.folderId,
				labelId: action.labelId,
				forwardTo: action.forwardTo,
				sectionName: action.sectionName,
			});
		}
		if (filter.stopProcessing) {
			stopped = true;
			break;
		}
	}

	return { matchedFilterIds: matched, actions, stopped };
}
