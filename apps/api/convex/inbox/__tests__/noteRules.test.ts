import { describe, expect, it } from 'vitest';
import {
	MAX_NOTE_MENTIONS,
	candidateHandles,
	diffMentions,
	normalizeNoteBody,
	resolveMentionedUserIds,
	toNoteView,
	type MentionCandidate,
} from '../noteRules';
import type { Doc, Id } from '../../_generated/dataModel';

const ADA: MentionCandidate = { userId: 'u_ada', email: 'Ada@example.com', name: 'Ada Marlow' };
const BEN: MentionCandidate = { userId: 'u_ben', email: 'ben@example.com', name: null };
const BEN_TOO: MentionCandidate = { userId: 'u_ben2', email: 'ben@other.example', name: 'Ben' };

describe('normalizeNoteBody', () => {
	it('trims, unifies line ends and drops control characters but keeps tabs and newlines', () => {
		expect(normalizeNoteBody('  hi\r\nthere\rnow\t!\u0000\u001b ')).toBe('hi\nthere\nnow\t!');
	});
});

describe('candidateHandles', () => {
	it('answers to the email local part and the dotted name, lowercased', () => {
		expect(candidateHandles(ADA)).toEqual(['ada', 'ada.marlow']);
		expect(candidateHandles({ userId: 'x', email: null, name: null })).toEqual([]);
	});
});

describe('resolveMentionedUserIds', () => {
	it('resolves handles in order of first appearance, once each', () => {
		expect(resolveMentionedUserIds('@ben then @Ada.Marlow and @ada', [ADA, BEN], 'u_x')).toEqual([
			'u_ben',
			'u_ada',
		]);
	});

	it('never mentions the author or anyone outside the candidates', () => {
		expect(resolveMentionedUserIds('@ada @zed', [ADA, BEN], 'u_ada')).toEqual([]);
	});

	it('reaches everyone a shared handle names, like chat does', () => {
		expect(resolveMentionedUserIds('@ben', [BEN, BEN_TOO], 'u_x')).toEqual(['u_ben', 'u_ben2']);
	});

	it('reads a full stop or dash after a handle as punctuation, not as part of it', () => {
		expect(resolveMentionedUserIds('Thanks @ben. And @ada.marlow...', [ADA, BEN], 'u_x')).toEqual([
			'u_ben',
			'u_ada',
		]);
		expect(resolveMentionedUserIds('@ada- can you check?', [ADA], 'u_x')).toEqual(['u_ada']);
	});

	it('ignores an @ inside a word such as an email address', () => {
		expect(resolveMentionedUserIds('mail ada@example.com', [ADA], 'u_x')).toEqual([]);
	});

	it('caps how many people one note reaches', () => {
		const many = Array.from({ length: MAX_NOTE_MENTIONS + 5 }, (_, i) => ({
			userId: `u_${i}`,
			email: `p${i}@example.com`,
			name: null,
		}));
		const body = many.map((_, i) => `@p${i}`).join(' ');
		expect(resolveMentionedUserIds(body, many, 'u_x')).toHaveLength(MAX_NOTE_MENTIONS);
	});
});

describe('diffMentions', () => {
	it('splits an edit into who was added and who was dropped', () => {
		expect(diffMentions(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
	});
});

describe('toNoteView', () => {
	const note = {
		_id: 'n1' as Id<'threadNotes'>,
		_creationTime: 1,
		threadId: 't1' as Id<'conversationThreads'>,
		authorId: 'u_ada',
		body: 'secret plan @ben',
		mentionedUserIds: ['u_ben'],
		createdAt: 10,
	} satisfies Doc<'threadNotes'>;
	const author = { name: 'Ada', email: 'ada@example.com', image: null };

	it('passes a live note through', () => {
		expect(toNoteView(note, author)).toMatchObject({
			body: 'secret plan @ben',
			isDeleted: false,
			editedAt: null,
		});
	});

	it('never ships the text of a deleted note', () => {
		expect(toNoteView({ ...note, deletedAt: 20 }, author)).toMatchObject({
			body: '',
			mentionedUserIds: [],
			isDeleted: true,
		});
	});
});
