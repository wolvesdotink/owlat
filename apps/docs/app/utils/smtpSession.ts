/**
 * Data for the `::smtp-session` replay on "How email works": the scripted
 * SMTP transcript, the five protocol phases it walks through, and the parsers
 * that split each line into its highlighted parts.
 *
 * Lives beside the components rather than inside them so the transcript can
 * be read and edited without scrolling past the terminal's layout CSS.
 */

export type LineType = 'server' | 'client' | 'annotation' | 'blank' | 'phase-sep';

export interface SmtpLine {
	type: LineType;
	text: string;
	phase: string;
	delay: number;
	/** For rich rendering inside DATA */
	semantic?: 'command' | 'header' | 'body' | 'terminator';
}

export const smtpSessionLines: SmtpLine[] = [
	// Connection phase
	{ type: 'server', text: '220 mx.example.com ESMTP ready', phase: 'connection', delay: 600 },
	{
		type: 'client',
		text: 'EHLO mail.sender.com',
		phase: 'connection',
		delay: 500,
		semantic: 'command',
	},
	{ type: 'server', text: '250-mx.example.com Hello', phase: 'connection', delay: 300 },
	{ type: 'server', text: '250-SIZE 35882577', phase: 'connection', delay: 150 },
	{ type: 'server', text: '250-STARTTLS', phase: 'connection', delay: 150 },
	{ type: 'server', text: '250 OK', phase: 'connection', delay: 300 },

	// TLS phase
	{ type: 'phase-sep', text: '', phase: 'tls', delay: 200 },
	{ type: 'client', text: 'STARTTLS', phase: 'tls', delay: 500, semantic: 'command' },
	{ type: 'server', text: '220 Ready to start TLS', phase: 'tls', delay: 400 },
	{
		type: 'annotation',
		text: 'TLS handshake — connection is now encrypted',
		phase: 'tls',
		delay: 1400,
	},
	{ type: 'client', text: 'EHLO mail.sender.com', phase: 'tls', delay: 500, semantic: 'command' },
	{ type: 'server', text: '250 OK', phase: 'tls', delay: 300 },

	// Envelope phase
	{ type: 'phase-sep', text: '', phase: 'envelope', delay: 200 },
	{
		type: 'client',
		text: 'MAIL FROM:<alice@sender.com>',
		phase: 'envelope',
		delay: 500,
		semantic: 'command',
	},
	{ type: 'server', text: '250 OK', phase: 'envelope', delay: 300 },
	{
		type: 'client',
		text: 'RCPT TO:<bob@example.com>',
		phase: 'envelope',
		delay: 500,
		semantic: 'command',
	},
	{ type: 'server', text: '250 OK', phase: 'envelope', delay: 300 },

	// Data phase
	{ type: 'phase-sep', text: '', phase: 'data', delay: 200 },
	{ type: 'client', text: 'DATA', phase: 'data', delay: 500, semantic: 'command' },
	{ type: 'server', text: '354 Start mail input', phase: 'data', delay: 400 },
	{
		type: 'client',
		text: 'From: Alice <alice@sender.com>',
		phase: 'data',
		delay: 350,
		semantic: 'header',
	},
	{
		type: 'client',
		text: 'To: Bob <bob@example.com>',
		phase: 'data',
		delay: 250,
		semantic: 'header',
	},
	{ type: 'client', text: 'Subject: Hello!', phase: 'data', delay: 250, semantic: 'header' },
	{
		type: 'client',
		text: 'Date: Sat, 22 Mar 2026 10:00:00 +0000',
		phase: 'data',
		delay: 250,
		semantic: 'header',
	},
	{ type: 'blank', text: '', phase: 'data', delay: 200 },
	{ type: 'client', text: 'Hi Bob, how are you?', phase: 'data', delay: 500, semantic: 'body' },
	{ type: 'client', text: '.', phase: 'data', delay: 700, semantic: 'terminator' },
	{ type: 'server', text: '250 OK: queued as 12345', phase: 'data', delay: 500 },

	// Quit phase
	{ type: 'phase-sep', text: '', phase: 'quit', delay: 200 },
	{ type: 'client', text: 'QUIT', phase: 'quit', delay: 400, semantic: 'command' },
	{ type: 'server', text: '221 Bye', phase: 'quit', delay: 400 },
];

/** One protocol phase in the progress bar; `key` matches `SmtpLine.phase`. */
export interface SmtpPhase {
	key: string;
	label: string;
	color: 'brand' | 'warning' | 'info' | 'accent' | 'success';
	/** `d` attribute of a single 24×24 stroked path. */
	icon: string;
}

export const smtpSessionPhases: SmtpPhase[] = [
	{ key: 'connection', label: 'Connect', color: 'brand', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
	{
		key: 'tls',
		label: 'Encrypt',
		color: 'warning',
		icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
	},
	{
		key: 'envelope',
		label: 'Envelope',
		color: 'info',
		icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
	},
	{
		key: 'data',
		label: 'Message',
		color: 'accent',
		icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
	},
	{ key: 'quit', label: 'Close', color: 'success', icon: 'M5 13l4 4L19 7' },
];

/** Parse server response into status code + rest */
export function parseServerText(text: string): { code: string; rest: string } {
	const match = text.match(/^(\d{3}[-\s]?)(.*)$/);
	if (match) return { code: match[1] ?? '', rest: match[2] ?? '' };
	return { code: '', rest: text };
}

/** Parse client command into keyword + args */
export function parseClientCommand(text: string): { keyword: string; args: string } | null {
	const commands = ['EHLO', 'STARTTLS', 'MAIL FROM:', 'RCPT TO:', 'DATA', 'QUIT'];
	for (const cmd of commands) {
		if (text.startsWith(cmd)) {
			return { keyword: cmd, args: text.slice(cmd.length) };
		}
	}
	return null;
}

/** Parse a header line into key + value */
export function parseHeader(text: string): { key: string; value: string } | null {
	const idx = text.indexOf(':');
	if (idx < 0) return null;
	return { key: text.slice(0, idx + 1), value: text.slice(idx + 1) };
}
