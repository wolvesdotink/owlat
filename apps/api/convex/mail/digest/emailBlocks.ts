/**
 * Read on arrival: the digest section of the personal Daily Brief
 * email, as renderer blocks. Grouped Newsletters / Updates / Promotions /
 * Cold outreach, at most 5 lines per group (chosen at selection), each line
 * linking to its mail, then "and N more" (or "and at least N more" past 200
 * threads).
 *
 * A line is the sender and the verbatim spans picked from the mail, or its
 * subject when there are none. Everything is escaped: spans and subjects are
 * the sender's text.
 *
 * Isolate-safe; not a Convex function.
 */

import type { EditorBlock } from '@owlat/shared';
import { escapeHtml } from '@owlat/shared/html';
import type { dailyBriefEmailCopy } from '../../lib/systemEmailCopy';
import type { DigestEmail } from './view';

type Copy = ReturnType<typeof dailyBriefEmailCopy>;

function paragraph(id: string, html: string, color = '#1a1a1a', fontSize = 15): EditorBlock {
	return {
		id,
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize, textColor: color },
	};
}

/** The digest section's blocks; empty when no group has a line or overflow. */
export function digestBlocks(input: {
	digest: DigestEmail;
	copy: Copy;
	baseUrl: string;
}): EditorBlock[] {
	const { digest, copy, baseUrl } = input;
	if (digest.groups.length === 0) return [];
	const blocks: EditorBlock[] = [
		paragraph(
			'digest-heading',
			`<strong style="font-size:17px">${escapeHtml(copy.digestHeading)}</strong>`,
			'#1a1a1a',
			17
		),
	];
	for (const group of digest.groups) {
		const lines = group.lines.map((line) => {
			const text = line.spans.length > 0 ? line.spans.join(' ') : line.subject;
			const href = `${baseUrl}${line.path}`;
			return (
				`<a href="${escapeHtml(href)}"><b>${escapeHtml(line.sender)}</b></a> ` +
				`<span>${escapeHtml(text)}</span>`
			);
		});
		if (group.more > 0) {
			const more =
				digest.overflowLabel === 'at_least'
					? copy.digestAtLeastMore(group.more)
					: copy.digestMore(group.more);
			lines.push(`<span style="color:#666">${escapeHtml(more)}</span>`);
		}
		blocks.push(
			paragraph(
				`digest-${group.kind}`,
				`<strong>${escapeHtml(copy.digestGroups[group.kind])}</strong><br>${lines.join('<br>')}`,
				'#1a1a1a',
				14
			)
		);
	}
	return blocks;
}
