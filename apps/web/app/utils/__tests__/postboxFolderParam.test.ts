import { describe, it, expect } from 'vitest';
import { resolvePostboxFolderParam } from '../postboxFolderParam';

describe('resolvePostboxFolderParam', () => {
	it.each(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'snoozed'])(
		'passes the system role %s through with no folder id',
		(role) => {
			expect(resolvePostboxFolderParam(role)).toEqual({ folderRole: role });
		}
	);

	it('treats anything else as a custom folder id', () => {
		// A custom folder carries no role, so the layout must query by id — and it
		// can only resolve the folder NAME (list header, mobile back button) from
		// the id. Passing the raw param through as a role labels the button with
		// this string.
		expect(resolvePostboxFolderParam('k17abc123def456')).toEqual({
			folderRole: '',
			folderId: 'k17abc123def456',
		});
	});

	it('defaults a missing param to the inbox', () => {
		expect(resolvePostboxFolderParam(undefined)).toEqual({ folderRole: 'inbox' });
	});
});
