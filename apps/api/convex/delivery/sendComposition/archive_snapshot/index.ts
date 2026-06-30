/**
 * Send composition (module) — `archive_snapshot` composer.
 *
 * Owns the placeholder-contact personalization for the campaign archive
 * snapshot. The snapshot is written once per campaign at orchestrator time
 * (`emails.ts:archiveHtml`) and rendered later from the `/archive?token=`
 * endpoint. Recipients viewing the archive see the same template every
 * time, so we personalize against an empty placeholder.
 *
 * Behaviour preserved from pre-deepening (`emails.ts:309`): the placeholder
 * is `{ email: '', firstName: '', lastName: '' }`, so `{{firstName}}`
 * renders as empty and `{{firstName|'friend'}}` renders as `'friend'`.
 *
 * The subject is *not* personalized (matches today's site, which passes
 * `archiveSubject` through raw).
 */

import { personalize } from '../personalization';
import type {
	ArchiveSnapshotComposeInput,
	ComposerOutput,
} from '../types';

const ARCHIVE_PLACEHOLDER = {
	email: '',
	firstName: '',
	lastName: '',
};

export function composeArchiveSnapshot(
	input: ArchiveSnapshotComposeInput,
): ComposerOutput {
	const html = personalize(input.template.htmlContent, ARCHIVE_PLACEHOLDER, {
		escape: 'html',
	});

	return {
		subject: input.template.subject,
		html,
		headers: {},
		attachmentRefs: [],
		transformConfig: null,
	};
}
