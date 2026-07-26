import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ACCOUNT_EXPORT_ORGANIZATION_RESOURCES, type AccountExportResource } from '@owlat/shared';
import type { ConvexClient } from 'convex/browser';
import {
	jsonArray,
	jsonObject,
	jsonValue,
	type JsonValueWriter,
	type TextChunkSink,
} from './incrementalJsonSerializer';
import { jsonObjectWithStreamedProperties, writeJsonDownload } from './incrementalJsonDownload';

type ExportPageOptions = {
	organizationId?: string;
	mailboxId?: Id<'mailboxes'>;
};

type AccountExportContext = {
	client: ConvexClient;
	userId: string;
	exportSessionId: Id<'accountExportSessions'>;
};

async function* iterateAccountExportPageRows(
	context: AccountExportContext,
	resource: AccountExportResource,
	options: ExportPageOptions = {}
): AsyncGenerator<Record<string, unknown>> {
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	for (;;) {
		const result = await context.client.action(api.auth.accountExport.exportUserDataPage, {
			userId: context.userId,
			exportSessionId: context.exportSessionId,
			resource,
			...(cursor ? { cursor } : {}),
			...(options.organizationId ? { organizationId: options.organizationId } : {}),
			...(options.mailboxId ? { mailboxId: options.mailboxId } : {}),
		});
		for (const rowJson of result.pageJson) {
			yield JSON.parse(rowJson) as Record<string, unknown>;
		}
		if (result.isDone) return;
		if (!result.continueCursor || seenCursors.has(result.continueCursor)) {
			throw new Error('Account export pagination did not advance');
		}
		seenCursors.add(result.continueCursor);
		cursor = result.continueCursor;
	}
}

async function* accountExportRowWriters(
	context: AccountExportContext,
	resource: AccountExportResource,
	options: ExportPageOptions = {}
): AsyncGenerator<JsonValueWriter> {
	for await (const row of iterateAccountExportPageRows(context, resource, options)) {
		const contentDownloadUrl = row['contentDownloadUrl'];
		if (typeof contentDownloadUrl !== 'string') {
			yield jsonValue(row);
			continue;
		}
		const contentArtifactId = row['contentArtifactId'];
		const contentLeaseToken = row['contentLeaseToken'];
		if (typeof contentArtifactId !== 'string' || typeof contentLeaseToken !== 'string') {
			throw new Error('Account export content is missing its artifact lease');
		}
		const response = await fetch(contentDownloadUrl);
		if (!response.ok || !response.body) {
			throw new Error('Could not stream account export content');
		}
		const {
			['contentDownloadUrl']: _download,
			['contentArtifactId']: _artifact,
			['contentLeaseToken']: _lease,
			...metadata
		} = row;
		yield jsonObjectWithStreamedProperties(metadata, response.body);
		await context.client.action(api.auth.accountExport.acknowledgeExportArtifact, {
			userId: context.userId,
			exportSessionId: context.exportSessionId,
			artifactId: contentArtifactId as Id<'accountExportArtifacts'>,
			leaseToken: contentLeaseToken,
		});
	}
}

export async function writeAccountJsonExport(
	client: ConvexClient,
	userId: string,
	sink: TextChunkSink
): Promise<void> {
	let serializationStarted = false;
	try {
		const manifest = await client.action(api.auth.accountExport.exportUserData, { userId });
		const context: AccountExportContext = {
			client,
			userId,
			exportSessionId: manifest.exportSessionId as Id<'accountExportSessions'>,
		};
		async function* mailboxWriters(): AsyncGenerator<JsonValueWriter> {
			for await (const mailbox of iterateAccountExportPageRows(context, 'mailboxes')) {
				yield jsonValue(mailbox);
			}
		}
		async function* mailboxResourceWriters(
			resource: 'mailMessages' | 'mailDrafts'
		): AsyncGenerator<JsonValueWriter> {
			for await (const mailbox of iterateAccountExportPageRows(context, 'mailboxes')) {
				if (typeof mailbox['_id'] !== 'string') {
					throw new Error('Account export mailbox is missing its ID');
				}
				yield* accountExportRowWriters(context, resource, {
					mailboxId: mailbox['_id'] as Id<'mailboxes'>,
				});
			}
		}
		async function* organizationWriters(): AsyncGenerator<JsonValueWriter> {
			for await (const membership of iterateAccountExportPageRows(
				context,
				'organizationMemberships'
			)) {
				const organizationId = membership['organizationId'];
				if (typeof organizationId !== 'string') {
					throw new Error('Account export membership is missing its organization ID');
				}
				yield jsonObject([
					['organization', jsonValue(membership['organization'])],
					['role', jsonValue(membership['role'])],
					[
						'data',
						jsonObject(
							ACCOUNT_EXPORT_ORGANIZATION_RESOURCES.map(
								(resource) =>
									[
										resource,
										jsonArray(
											accountExportRowWriters(context, resource, {
												organizationId,
											})
										),
									] as const
							)
						),
					],
				]);
			}
		}

		const manifestEntries = Object.entries(manifest)
			.filter(
				([key]) => key !== 'exportSessionId' && key !== 'organizations' && key !== 'personalData'
			)
			.map(([key, value]) => [key, jsonValue(value)] as const);
		const document = jsonObject([
			...manifestEntries,
			['organizations', jsonArray(organizationWriters())],
			[
				'personalData',
				jsonObject([
					['mailboxes', jsonArray(mailboxWriters())],
					['mailMessages', jsonArray(mailboxResourceWriters('mailMessages'))],
					['mailDrafts', jsonArray(mailboxResourceWriters('mailDrafts'))],
					[
						'externalMailAccounts',
						jsonArray(accountExportRowWriters(context, 'externalMailAccounts')),
					],
					['chatMessages', jsonArray(accountExportRowWriters(context, 'chatMessages'))],
					[
						'deliverabilityAlertRecipientStates',
						jsonArray(accountExportRowWriters(context, 'deliverabilityAlertRecipientStates')),
					],
				]),
			],
		]);
		serializationStarted = true;
		await writeJsonDownload(sink, document);
	} catch (error) {
		if (!serializationStarted) {
			try {
				await sink.abort(error);
			} catch {
				// Preserve the export failure even if rolling back the destination fails.
			}
		}
		throw error;
	}
}
