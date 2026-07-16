/**
 * SMTP reply parser.
 *
 * Parses the multiline reply grammar of RFC 5321 §4.2 — a sequence of lines
 * that share a three-digit reply code, where continuation lines use a `-`
 * separator (`250-...`) and the final line uses a space (`250 ...`). The
 * per-line text may begin with an RFC 3463 enhanced status code (`X.Y.Z`),
 * which we extract into a dedicated field.
 *
 * The parser is deliberately tolerant of real-world servers: it accepts a
 * missing separator, extra leading whitespace, and lowercase text, because
 * downstream code classifies on the STRUCTURED code — never on the raw bytes.
 */

const REPLY_LINE = /^[ \t]*(\d{3})([ \t-]?)([\s\S]*)$/;
// RFC 3463 enhanced status code: class (2/4/5) "." subject "." detail.
const ENHANCED_CODE = /^([245])\.(\d{1,3})\.(\d{1,3})(?=[ \t]|$)/;

export interface SmtpReply {
	/** The three-digit reply code (from the final line). */
	code: number;
	/** RFC 3463 enhanced status code (`X.Y.Z`), if the server supplied one. */
	enhancedCode?: string;
	/** Text portion of each reply line, enhanced code stripped from the front. */
	lines: string[];
	/** The reply text joined with newlines (convenience). */
	text: string;
}

interface ParsedLine {
	code: number;
	/** `true` when this is the final line of the reply (space separator). */
	final: boolean;
	/** Text after the code+separator, with a leading enhanced code removed. */
	text: string;
	/** Enhanced status code found at the start of the text, if any. */
	enhancedCode?: string;
}

function stripEnhancedCode(raw: string): { text: string; enhancedCode?: string } {
	const match = ENHANCED_CODE.exec(raw);
	if (!match) {
		return { text: raw };
	}
	const enhancedCode = match[0];
	const rest = raw.slice(enhancedCode.length).replace(/^[ \t]+/, '');
	return { text: rest, enhancedCode };
}

/**
 * Parse a single reply line. Returns `undefined` for a line that does not begin
 * with a three-digit code (e.g. a blank keepalive line), so callers can skip it.
 */
export function parseReplyLine(line: string): ParsedLine | undefined {
	const match = REPLY_LINE.exec(line);
	if (!match) {
		return undefined;
	}
	const code = Number.parseInt(match[1] ?? '', 10);
	const separator = match[2] ?? '';
	const remainder = match[3] ?? '';
	const { text, enhancedCode } = stripEnhancedCode(remainder);
	const parsed: ParsedLine = {
		code,
		// Only a hyphen marks a continuation; anything else (space, empty,
		// or a sloppy server that ran the text straight on) is the final line.
		final: separator !== '-',
		text,
	};
	if (enhancedCode !== undefined) {
		parsed.enhancedCode = enhancedCode;
	}
	return parsed;
}

function buildReply(parsedLines: ParsedLine[]): SmtpReply {
	const last = parsedLines[parsedLines.length - 1];
	if (last === undefined) {
		throw new Error('cannot build an SMTP reply from zero lines');
	}
	const lines = parsedLines.map((l) => l.text);
	// The enhanced code of the final line is authoritative; fall back to the
	// first line that carried one (some servers only stamp the opener).
	let enhancedCode = last.enhancedCode;
	if (enhancedCode === undefined) {
		for (const l of parsedLines) {
			if (l.enhancedCode !== undefined) {
				enhancedCode = l.enhancedCode;
				break;
			}
		}
	}
	const reply: SmtpReply = {
		code: last.code,
		lines,
		text: lines.join('\n'),
	};
	if (enhancedCode !== undefined) {
		reply.enhancedCode = enhancedCode;
	}
	return reply;
}

/**
 * Parse a complete, already-buffered reply (one or more lines). Accepts CRLF or
 * bare-LF separated input. Throws if the buffer contains no parseable line.
 */
export function parseReply(raw: string): SmtpReply {
	const parsedLines: ParsedLine[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line === '') {
			continue;
		}
		const parsed = parseReplyLine(line);
		if (parsed !== undefined) {
			parsedLines.push(parsed);
		}
	}
	if (parsedLines.length === 0) {
		throw new Error(`no parseable SMTP reply in input: ${JSON.stringify(raw)}`);
	}
	return buildReply(parsedLines);
}

/**
 * Incremental reply reader for a socket byte stream. Feed raw chunks with
 * {@link ReplyParser.push}; it returns every COMPLETE reply that became
 * available (a reply completes when its final, space-separator line arrives).
 * Partial trailing data is buffered until the next chunk.
 */
export class ReplyParser {
	private buffer = '';
	private pending: ParsedLine[] = [];

	push(chunk: string): SmtpReply[] {
		this.buffer += chunk;
		const replies: SmtpReply[] = [];
		let newlineIndex = this.buffer.indexOf('\n');
		while (newlineIndex !== -1) {
			let line = this.buffer.slice(0, newlineIndex);
			if (line.endsWith('\r')) {
				line = line.slice(0, -1);
			}
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line !== '') {
				const parsed = parseReplyLine(line);
				if (parsed !== undefined) {
					this.pending.push(parsed);
					if (parsed.final) {
						replies.push(buildReply(this.pending));
						this.pending = [];
					}
				}
			}
			newlineIndex = this.buffer.indexOf('\n');
		}
		return replies;
	}

	/** `true` when a reply is mid-arrival (lines buffered but not yet final). */
	get hasPending(): boolean {
		return this.pending.length > 0 || this.buffer.length > 0;
	}
}

/** `true` for a 2xx positive-completion reply. */
export function isPositiveCompletion(code: number): boolean {
	return code >= 200 && code < 300;
}

/** `true` for a 3xx positive-intermediate reply (e.g. 354 after `DATA`). */
export function isPositiveIntermediate(code: number): boolean {
	return code >= 300 && code < 400;
}
