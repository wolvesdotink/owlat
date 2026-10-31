/**
 * The decisions of an account export page (`auth/accountExport.ts`,
 * `exportUserDataPage`) and of staging its content (`stageArtifact` in
 * `auth/accountExportArtifacts.ts`): how many rows a page holds, what a row
 * exposes inline and what goes into its staged artifact, and whether a staged
 * blob is leased, registered or minted again. Pure: the action and the
 * mutation load and write; these functions take what they read.
 */

const ACCOUNT_EXPORT_PAGE_SIZE = 100;
/** A content row stages one artifact, so a content page holds one row. */
const ACCOUNT_EXPORT_CONTENT_PAGE_SIZE = 1;

/** The resources whose rows carry body or template content staged as an artifact. */
export function isContentResource(resource: string): boolean {
	return (
		resource === 'mailMessages' ||
		resource === 'mailDrafts' ||
		resource === 'emailTemplates' ||
		resource === 'transactionalEmails'
	);
}

export function exportPageSize(resource: string): number {
	return isContentResource(resource) ? ACCOUNT_EXPORT_CONTENT_PAGE_SIZE : ACCOUNT_EXPORT_PAGE_SIZE;
}

/** The artifact scope of one row: its content is addressed within it. */
export function artifactScope(resource: string, rowId: string): string {
	return `${resource}:${rowId}`;
}

/**
 * The caller's memberships with the organization each names; a membership
 * whose organization is gone is left out.
 */
export function membershipExportRows(
	memberships: ReadonlyArray<{ organizationId: string; role: string }>,
	organizations: ReadonlyArray<{ _id: string; name: string; slug?: string | null } | null>
) {
	return memberships.flatMap((membership, index) => {
		const organization = organizations[index];
		if (!organization) return [];
		return [
			{
				organizationId: membership.organizationId,
				role: membership.role,
				organization: { _id: organization._id, name: organization.name, slug: organization.slug },
			},
		];
	});
}

/** A mail message row without its blob handles and bodies, which go into its artifact. */
export function mailMessageExportRow<
	T extends {
		rawStorageId?: unknown;
		textBodyStorageId?: unknown;
		htmlBodyStorageId?: unknown;
		textBodyInline?: unknown;
		htmlBodyInline?: unknown;
	},
>(message: T) {
	const {
		rawStorageId: _raw,
		textBodyStorageId: _textStorage,
		htmlBodyStorageId: _htmlStorage,
		textBodyInline: _textInline,
		htmlBodyInline: _htmlInline,
		...row
	} = message;
	return row;
}

/**
 * An opened draft split into its inline row (attachment metadata without the
 * bytes) and the content its artifact stages (bodies and attachment bytes).
 */
export function splitDraftForExport<
	T extends {
		bodyHtml: unknown;
		bodyText?: unknown;
		bodyBlocks?: unknown;
		bodyAvailability: unknown;
		attachments: ReadonlyArray<{ contentBase64: unknown }>;
	},
>(opened: T) {
	const { bodyHtml, bodyText, bodyBlocks, bodyAvailability, attachments, ...row } = opened;
	return {
		row: {
			...row,
			attachments: attachments.map(({ contentBase64: _content, ...attachment }) => attachment),
		},
		content: {
			bodyHtml,
			...(bodyText === undefined ? {} : { bodyText }),
			...(bodyBlocks === undefined ? {} : { bodyBlocks }),
			bodyAvailability,
			attachments,
		},
	};
}

/**
 * What staging does with the blob a page minted its download link for:
 * - `lease` the artifact under the key when it holds that blob;
 * - `register` the blob as the key's artifact when none exists and the page
 *   stored the blob itself;
 * - `restage` otherwise (another blob took the key, or the artifact the page
 *   found is gone): nothing is leased, and the page mints its link again for
 *   what the key holds now.
 */
export function stagingStep(
	existing: { storageId: string } | null,
	staged: { storageId: string; isFreshBlob: boolean }
): 'lease' | 'register' | 'restage' {
	if (existing) return existing.storageId === staged.storageId ? 'lease' : 'restage';
	return staged.isFreshBlob ? 'register' : 'restage';
}
