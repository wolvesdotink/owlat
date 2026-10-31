/**
 * Decoders for the synthetic rows the scenarios send over their simulated
 * Convex wire (`JSON.stringify`, then `JSON.parse`, then `shareStructure`).
 *
 * The parsed array is checked against the row's schema and handed on as it
 * is, never copied: the scenarios measure what one delivery allocates and
 * which row identities structural sharing keeps, and a decoded copy would
 * change both. A row that does not match is a fixture bug, so it throws.
 */
import { isRecord } from '@owlat/shared/utils/guards';
import type { SyntheticInboxThread, SyntheticPostboxRow } from './listWorkload';
import type { SyntheticAssistantRow, SyntheticChatRow } from './workload';

type Check = (value: unknown) => boolean;

/** One check per field of `T`, optional fields included. */
type RowSchema<T> = { readonly [K in keyof T]-?: Check };

const string: Check = (value) => typeof value === 'string';
const number: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const boolean: Check = (value) => typeof value === 'boolean';
const oneOf =
	(...allowed: readonly unknown[]): Check =>
	(value) =>
		allowed.includes(value);
const nullable =
	(check: Check): Check =>
	(value) =>
		value === null || check(value);
const optional =
	(check: Check): Check =>
	(value) =>
		value === undefined || check(value);
const arrayOf =
	(check: Check): Check =>
	(value) =>
		Array.isArray(value) && value.every(check);
const object =
	<T>(schema: RowSchema<T>): Check =>
	(value) =>
		fieldIssue(schema, value) === null;

/** The first field of `value` that `schema` refuses, or `null` when it matches. */
function fieldIssue<T>(schema: RowSchema<T>, value: unknown): string | null {
	if (!isRecord(value)) return 'not an object';
	for (const [field, check] of Object.entries<Check>(schema)) {
		if (!check(value[field])) return `field "${field}"`;
	}
	return null;
}

function isRows<T>(schema: RowSchema<T>, value: unknown): value is T[] {
	return Array.isArray(value) && value.every((row) => fieldIssue(schema, row) === null);
}

function rowsDecoder<T>(name: string, schema: RowSchema<T>): (value: unknown) => T[] {
	return (value) => {
		if (isRows(schema, value)) return value;
		const issue = Array.isArray(value)
			? value
					.map((row, index) => [index, fieldIssue(schema, row)] as const)
					.find(([, rowIssue]) => rowIssue !== null)
			: undefined;
		throw new Error(
			issue
				? `${name} wire row ${issue[0]}: ${issue[1]} does not match the schema`
				: `${name} wire payload is not an array`
		);
	};
}

export const decodeAssistantRows = rowsDecoder<SyntheticAssistantRow>('Assistant', {
	_id: string,
	role: oneOf('user', 'assistant'),
	text: string,
	status: oneOf('streaming', 'complete', 'stopped', 'error'),
	toolCalls: arrayOf(object<{ status: string }>({ status: string })),
	errorMessage: nullable(string),
	budgetRefusal: oneOf(null),
	model: nullable(string),
	createdAt: number,
});

export const decodeChatRows = rowsDecoder<SyntheticChatRow>('Chat', {
	_id: string,
	roomId: string,
	authorId: string,
	author: object<SyntheticChatRow['author']>({
		name: nullable(string),
		email: nullable(string),
		image: nullable(string),
	}),
	isAssistant: boolean,
	text: string,
	mentions: arrayOf(string),
	createdAt: number,
	_creationTime: number,
});

export const decodePostboxRows = rowsDecoder<SyntheticPostboxRow>('Postbox', {
	_id: string,
	mailboxId: string,
	threadId: string,
	fromName: string,
	fromAddress: string,
	subject: string,
	snippet: string,
	receivedAt: number,
	flagSeen: boolean,
	flagFlagged: boolean,
	hasAttachments: boolean,
	pinnedAt: optional(number),
});

export const decodeInboxThreads = rowsDecoder<SyntheticInboxThread>('Team inbox', {
	_id: string,
	_creationTime: number,
	subject: string,
	contactIdentifier: string,
	status: oneOf('open', 'waiting'),
	latestDraftStatus: oneOf('pending', null),
	lastMessageAt: number,
	messageCount: number,
	lastPreview: string,
	unread: boolean,
	assignedTo: nullable(string),
	assignee: nullable(
		object<NonNullable<SyntheticInboxThread['assignee']>>({
			name: string,
			email: string,
			image: oneOf(null),
		})
	),
	responseDueAt: optional(number),
});
