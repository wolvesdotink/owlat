export const ACCOUNT_EXPORT_ORGANIZATION_RESOURCES = [
	'contacts',
	'contactProperties',
	'topics',
	'emailTemplates',
	'campaigns',
	'automations',
	'transactionalEmails',
	'segments',
	'apiKeys',
	'webhooks',
	'domains',
	'formEndpoints',
	'blockedEmails',
] as const;

export type AccountExportOrganizationResource =
	(typeof ACCOUNT_EXPORT_ORGANIZATION_RESOURCES)[number];

export const ACCOUNT_EXPORT_PERSONAL_RESOURCES = [
	'mailboxes',
	'mailMessages',
	'mailDrafts',
	'externalMailAccounts',
	'chatMessages',
	'deliverabilityAlertRecipientStates',
] as const;

export type AccountExportPersonalResource = (typeof ACCOUNT_EXPORT_PERSONAL_RESOURCES)[number];

export type AccountExportResource =
	| 'organizationMemberships'
	| AccountExportOrganizationResource
	| AccountExportPersonalResource;

export type SerializedAccountExportPage = {
	pageJson: string[];
	isDone: boolean;
	continueCursor: string;
};

export type AccountExportManifest = {
	exportSessionId: string;
	userProfile: {
		email: string;
		name?: string;
		image?: string;
		createdAt: number;
		updatedAt: number;
	};
	exportedAt: number;
};

const ORGANIZATION_RESOURCE_SET = new Set<string>(ACCOUNT_EXPORT_ORGANIZATION_RESOURCES);

export function isAccountExportOrganizationResource(
	resource: AccountExportResource
): resource is AccountExportOrganizationResource {
	return ORGANIZATION_RESOURCE_SET.has(resource);
}

export function serializeAccountExportPage<T>(result: {
	page: T[];
	isDone: boolean;
	continueCursor: string;
}): SerializedAccountExportPage {
	return {
		pageJson: result.page.map((row) => JSON.stringify(row)),
		isDone: result.isDone,
		continueCursor: result.continueCursor,
	};
}
