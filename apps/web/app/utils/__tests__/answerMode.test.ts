// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
	answerDraftHasContent,
	answerModeHref,
	answerTeamHref,
	bodyHasQuote,
	isAnswerModePath,
	parseAnswerKind,
	singleQueryValue,
} from '../answerMode';

describe('answerModeHref', () => {
	it('builds the route with the kind and the draft to open', () => {
		expect(answerModeHref('msg_1')).toBe('/dashboard/answer/m/msg_1');
		expect(answerModeHref('msg_1', { kind: 'replyAll' })).toBe(
			'/dashboard/answer/m/msg_1?kind=replyAll'
		);
		expect(answerModeHref('msg_1', { kind: 'reply', draftId: 'd_2' })).toBe(
			'/dashboard/answer/m/msg_1?kind=reply&draft=d_2'
		);
		expect(answerModeHref('msg_1', { kind: null, draftId: 'd_2' })).toBe(
			'/dashboard/answer/m/msg_1?draft=d_2'
		);
	});

	it('is recognised as Answer mode, and the queue index is not', () => {
		expect(isAnswerModePath(answerModeHref('msg_1'))).toBe(true);
		expect(isAnswerModePath(answerTeamHref('ct_1'))).toBe(true);
		expect(isAnswerModePath('/dashboard/answer')).toBe(false);
		expect(isAnswerModePath('/dashboard/postbox/inbox/msg_1')).toBe(false);
	});
});

describe('answerTeamHref', () => {
	it('builds the team route, with the message the reply answers when one is picked', () => {
		expect(answerTeamHref('ct_1')).toBe('/dashboard/answer/t/ct_1');
		expect(answerTeamHref('ct_1', { messageId: 'in_2' })).toBe(
			'/dashboard/answer/t/ct_1?message=in_2'
		);
	});
});

describe('parseAnswerKind / singleQueryValue', () => {
	it('accepts the three verbs and nothing else', () => {
		expect(parseAnswerKind('reply')).toBe('reply');
		expect(parseAnswerKind('replyAll')).toBe('replyAll');
		expect(parseAnswerKind(['forward'])).toBe('forward');
		expect(parseAnswerKind('replyall')).toBeNull();
		expect(parseAnswerKind(undefined)).toBeNull();
	});

	it('reads one non-empty string out of a route value', () => {
		expect(singleQueryValue('d_1')).toBe('d_1');
		expect(singleQueryValue(['d_1', 'd_2'])).toBe('d_1');
		expect(singleQueryValue('')).toBeNull();
		expect(singleQueryValue(null)).toBeNull();
	});
});

describe('answerDraftHasContent', () => {
	const quote =
		'<br><br><div class="gmail_quote"><div>On Monday, Jonas wrote:</div>' +
		'<blockquote class="gmail_quote">Could you send the invoice?</blockquote></div>';
	const signature = '<div data-postbox-signature="sig_1"><p>Ada</p></div>';

	it('is false for a reply nobody has written in yet (quote and signature only)', () => {
		expect(answerDraftHasContent(`<p><br></p>${signature}${quote}`, 0)).toBe(false);
	});

	it('is true once there is text outside the quote', () => {
		expect(answerDraftHasContent(`<p>Here it is.</p>${quote}`, 0)).toBe(true);
	});

	it('counts an attachment as content', () => {
		expect(answerDraftHasContent(quote, 1)).toBe(true);
	});

	it('knows a quoted body when it sees one', () => {
		expect(bodyHasQuote(quote)).toBe(true);
		expect(bodyHasQuote('<p>Hello</p>')).toBe(false);
	});
});
