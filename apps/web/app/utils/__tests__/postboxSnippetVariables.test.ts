import { describe, it, expect } from 'vitest';
import {
	SNIPPET_VARIABLE_SOURCES,
	promptedSnippetVariables,
	resolveSnippetBody,
	snippetTokens,
	snippetVariableSourceKey,
	type SnippetVariable,
} from '../postboxSnippetVariables';
import { preflightDraft } from '../postboxPreflight';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;

const context = {
	recipientFirstName: 'Ines',
	recipientFullName: 'Ines Weber',
	recipientCompany: 'Northwind Studio',
	senderName: 'Ada Lovelace',
	senderEmail: 'ada@owlat.test',
	date: '27.08.2026',
};

describe('snippetVariableSourceKey', () => {
	it('has a translation for every source', () => {
		for (const source of SNIPPET_VARIABLE_SOURCES) {
			const key = snippetVariableSourceKey(source);
			expect(t(key)).not.toBe(key);
		}
	});
});

describe('snippetTokens', () => {
	it('lists each distinct token once, in reading order', () => {
		expect(snippetTokens('<p>Hi {{firstName}}, from {{senderName}} — {{firstName}}</p>')).toEqual([
			'firstName',
			'senderName',
		]);
	});

	it('reads the spaced spelling people hand-type into the editor', () => {
		expect(snippetTokens('{{ firstName }}')).toEqual(['firstName']);
	});

	it('is empty for a body with no tokens', () => {
		expect(snippetTokens('<p>Nothing to fill in.</p>')).toEqual([]);
	});
});

describe('resolveSnippetBody', () => {
	it('resolves an undeclared {{firstName}} exactly as it always did', () => {
		const { html, unresolved } = resolveSnippetBody('<p>Hi {{firstName}},</p>', { context });
		expect(html).toBe('<p>Hi Ines,</p>');
		expect(unresolved).toEqual([]);
	});

	it('resolves every declared source from the composer context', () => {
		const declared: SnippetVariable[] = [
			{ token: 'who', source: 'recipientFullName' },
			{ token: 'where', source: 'recipientCompany' },
			{ token: 'me', source: 'senderName' },
			{ token: 'reply', source: 'senderEmail' },
			{ token: 'when', source: 'date' },
		];
		const { html } = resolveSnippetBody('{{who}}|{{where}}|{{me}}|{{reply}}|{{when}}', {
			declared,
			context,
		});
		expect(html).toBe('Ines Weber|Northwind Studio|Ada Lovelace|ada@owlat.test|27.08.2026');
	});

	it('takes a prompt answer over anything the context could offer', () => {
		const declared: SnippetVariable[] = [{ token: 'ticket', source: 'prompt', label: 'Ticket' }];
		const { html, unresolved } = resolveSnippetBody('<p>Ref {{ticket}}</p>', {
			declared,
			context,
			answers: { ticket: ' 4471 ' },
		});
		expect(html).toBe('<p>Ref 4471</p>');
		expect(unresolved).toEqual([]);
	});

	it('falls back to the token’s own inline default before giving up', () => {
		const { html, unresolved } = resolveSnippetBody("<p>Hi {{firstName|'there'}},</p>", {
			context: {},
		});
		expect(html).toBe('<p>Hi there,</p>');
		expect(unresolved).toEqual([]);
	});

	it('HTML-escapes resolved values (recipient data is untrusted)', () => {
		const { html } = resolveSnippetBody('{{firstName}}', {
			context: { recipientFirstName: '<img src=x onerror=alert(1)>' },
		});
		expect(html).toBe('&lt;img src=x onerror=alert(1)&gt;');
	});

	it('never resolves a prompt variable from the context', () => {
		const declared: SnippetVariable[] = [{ token: 'firstName', source: 'prompt' }];
		const { unresolved } = resolveSnippetBody('{{firstName}}', { declared, context });
		expect(unresolved).toEqual(['firstName']);
	});

	/**
	 * The load-bearing half of idea 13: an unfilled variable is left as its
	 * literal token, which is exactly the shape the composer's preflight (idea 6)
	 * already flags beside Send. A `[token]` marker would have shipped silently.
	 */
	it('leaves an unresolved token standing, where the preflight catches it', () => {
		const { html, unresolved } = resolveSnippetBody('<p>Hi {{firstName}},</p>', { context: {} });
		expect(html).toBe('<p>Hi {{firstName}},</p>');
		expect(unresolved).toEqual(['firstName']);

		const findings = preflightDraft({ subject: 'Hello', bodyHtml: html });
		expect(findings.map((f) => f.id)).toContain('unfilledVariable');
		expect(findings.find((f) => f.id === 'unfilledVariable')?.params).toMatchObject({
			name: 'firstName',
		});
	});

	it('reports each unresolved token once, however often it appears', () => {
		const { unresolved } = resolveSnippetBody('{{a}} {{a}} {{b}}', { context: {} });
		expect(unresolved).toEqual(['a', 'b']);
	});
});

describe('promptedSnippetVariables', () => {
	const declared: SnippetVariable[] = [
		{ token: 'ticket', source: 'prompt', label: 'Ticket number' },
		{ token: 'link', source: 'prompt' },
		{ token: 'firstName', source: 'recipientFirstName' },
	];

	it('asks only for the prompt variables the body actually uses', () => {
		const fields = promptedSnippetVariables('<p>Hi {{firstName}}, ref {{ticket}}</p>', declared);
		expect(fields.map((f) => f.token)).toEqual(['ticket']);
	});

	it('asks nothing once the tokens are edited out of the body', () => {
		expect(promptedSnippetVariables('<p>Hi there</p>', declared)).toEqual([]);
	});
});
