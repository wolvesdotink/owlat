import { describe, expect, it } from 'vitest';
import {
	activeMentionQuery,
	countNotesMentioning,
	insertMention,
	interleaveNotes,
	mentionHandle,
	noteMentionCandidates,
} from '../threadNotes';

const member = (
	userId: string,
	role: 'owner' | 'admin' | 'editor',
	name: string,
	email: string
) => ({
	userId,
	role,
	user: { name, email, image: null },
});
const MEMBERS = [
	member('u_ada', 'owner', 'Ada Marlow', 'ada@example.com'),
	member('u_ben', 'admin', 'Ben Ortiz', 'Ben.O@example.com'),
	member('u_eve', 'editor', 'Eve Editor', 'eve@example.com'),
];

describe('mentionHandle', () => {
	it('is the lowercased email local part', () => {
		expect(mentionHandle('Ben.O@example.com')).toBe('ben.o');
		expect(mentionHandle('')).toBeNull();
	});
});

describe('noteMentionCandidates', () => {
	it('offers Team Inbox readers only, never the author', () => {
		expect(noteMentionCandidates(MEMBERS, 'u_ada', '').map((c) => c.memberId)).toEqual(['u_ben']);
	});

	it('matches on handle or name', () => {
		expect(noteMentionCandidates(MEMBERS, null, 'ort').map((c) => c.handle)).toEqual(['ben.o']);
		expect(noteMentionCandidates(MEMBERS, null, 'ada').map((c) => c.handle)).toEqual(['ada']);
		expect(noteMentionCandidates(MEMBERS, null, 'eve')).toEqual([]);
	});
});

describe('activeMentionQuery', () => {
	it('finds the fragment being typed after an @ at a word start', () => {
		expect(activeMentionQuery('ask @be', 7)).toEqual({ start: 4, fragment: 'be' });
		expect(activeMentionQuery('@', 1)).toEqual({ start: 0, fragment: '' });
	});

	it('ignores an @ inside a word and a finished mention', () => {
		expect(activeMentionQuery('mail ada@exa', 12)).toBeNull();
		expect(activeMentionQuery('ask @ben now', 12)).toBeNull();
	});
});

describe('insertMention', () => {
	it('replaces the fragment with the handle and a space, and moves the caret past it', () => {
		expect(insertMention('ask @b please', 4, 6, 'ben.o')).toEqual({
			text: 'ask @ben.o  please',
			caret: 11,
		});
	});
});

describe('interleaveNotes', () => {
	const messages = [
		{ _id: 'm2', _creationTime: 200 },
		{ _id: 'm1', _creationTime: 100 },
	];
	it('puts each note after the newest message written before it', () => {
		const notes = [
			{ id: 'late', createdAt: 250 },
			{ id: 'early', createdAt: 50 },
			{ id: 'mid', createdAt: 150 },
			{ id: 'mid2', createdAt: 120 },
		];
		const { leading, after } = interleaveNotes(messages, notes);
		expect(leading.map((n) => n.id)).toEqual(['early']);
		expect(after.get('m1')?.map((n) => n.id)).toEqual(['mid2', 'mid']);
		expect(after.get('m2')?.map((n) => n.id)).toEqual(['late']);
	});

	it('keeps every note when there are no messages', () => {
		expect(interleaveNotes([], [{ createdAt: 1 }]).leading).toHaveLength(1);
	});
});

describe('countNotesMentioning', () => {
	it('counts the notes that mention the user, and nothing without one', () => {
		const notes = [
			{ mentionedUserIds: ['u_ben'] },
			{ mentionedUserIds: [] },
			{ mentionedUserIds: ['u_cy', 'u_ben'] },
		];
		expect(countNotesMentioning(notes, 'u_ben')).toBe(2);
		expect(countNotesMentioning(notes, 'u_ada')).toBe(0);
		expect(countNotesMentioning(notes, null)).toBe(0);
	});
});
