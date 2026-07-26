import type { Doc, Id } from '../_generated/dataModel';
import { accountExportBytesToBase64 } from './accountExportEncoding';
import type { BodyBlobStorageReader } from './messageBody';
import { readSealedBlobBytesForExport } from './sealedBlob';

type Availability = 'available' | 'missing' | 'corrupt';
type StoredContent = {
	contentBase64: string;
	contentEncoding: 'base64';
	availability: Availability;
};

export const ACCOUNT_EXPORT_TEMPLATE_ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const ACCOUNT_EXPORT_TEMPLATE_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
class TemplateMediaLimitError extends Error {}

export type AccountExportMediaAsset = {
	mediaAssetId: string;
	storageId: string;
};

type TemplateExportContext = {
	authorizedAssets: ReadonlyMap<string, string>;
	decodedMediaBytes: number;
};

function authorizedStorageId(
	context: TemplateExportContext,
	mediaAssetId: unknown,
	storageId: unknown
): string | undefined {
	if (typeof mediaAssetId !== 'string' || typeof storageId !== 'string') return undefined;
	return context.authorizedAssets.get(mediaAssetId) === storageId ? storageId : undefined;
}

async function storedContent(
	storage: BodyBlobStorageReader,
	storageId: string,
	context: TemplateExportContext
): Promise<StoredContent> {
	let source: Blob | null;
	try {
		source = await storage.get(storageId as Id<'_storage'>);
	} catch {
		return {
			contentBase64: '',
			contentEncoding: 'base64',
			availability: 'corrupt',
		};
	}
	if (source && source.size > ACCOUNT_EXPORT_TEMPLATE_ASSET_MAX_BYTES + 1_024) {
		throw new TemplateMediaLimitError(
			'Account export template media asset exceeds its per-asset limit'
		);
	}
	const opened = await readSealedBlobBytesForExport(storage, storageId as Id<'_storage'>);
	if (opened.content.byteLength > ACCOUNT_EXPORT_TEMPLATE_ASSET_MAX_BYTES) {
		throw new TemplateMediaLimitError(
			'Account export template media asset exceeds its per-asset limit'
		);
	}
	if (
		context.decodedMediaBytes + opened.content.byteLength >
		ACCOUNT_EXPORT_TEMPLATE_MEDIA_MAX_BYTES
	) {
		throw new TemplateMediaLimitError('Account export template media exceeds its aggregate limit');
	}
	context.decodedMediaBytes += opened.content.byteLength;
	return {
		contentBase64: accountExportBytesToBase64(opened.content),
		contentEncoding: 'base64',
		availability: opened.availability,
	};
}

function unavailableStoredContent(): StoredContent {
	return {
		contentBase64: '',
		contentEncoding: 'base64',
		availability: 'missing',
	};
}

async function sanitizeEditorValue(
	storage: BodyBlobStorageReader,
	value: unknown,
	context: TemplateExportContext
): Promise<unknown> {
	if (Array.isArray(value)) {
		const sanitized: unknown[] = [];
		for (const item of value) sanitized.push(await sanitizeEditorValue(storage, item, context));
		return sanitized;
	}
	if (value === null || typeof value !== 'object') return value;

	const source = value as Record<string, unknown>;
	const storageId = typeof source['storageId'] === 'string' ? source['storageId'] : undefined;
	const darkStorageId =
		typeof source['darkStorageId'] === 'string' ? source['darkStorageId'] : undefined;
	const authorizedPrimaryStorageId = authorizedStorageId(
		context,
		source['mediaAssetId'],
		storageId
	);
	const authorizedDarkStorageId = authorizedStorageId(
		context,
		source['darkMediaAssetId'],
		darkStorageId
	);
	const hasPrimaryImage = storageId !== undefined || typeof source['src'] === 'string';
	const hasDarkImage = darkStorageId !== undefined || typeof source['darkSrc'] === 'string';
	const entries: Array<readonly [string, unknown]> = [];
	for (const [key, nested] of Object.entries(source).filter(
		([key]) =>
			key !== 'storageId' &&
			key !== 'darkStorageId' &&
			key !== 'mediaAssetId' &&
			key !== 'darkMediaAssetId' &&
			key !== 'src' &&
			key !== 'darkSrc' &&
			key !== 'srcset' &&
			(!storageId || key !== 'url')
	)) {
		entries.push([key, await sanitizeEditorValue(storage, nested, context)] as const);
	}
	return {
		...Object.fromEntries(entries),
		...(hasPrimaryImage
			? {
					storedContent: authorizedPrimaryStorageId
						? await storedContent(storage, authorizedPrimaryStorageId, context)
						: unavailableStoredContent(),
				}
			: {}),
		...(hasDarkImage
			? {
					darkStoredContent: authorizedDarkStorageId
						? await storedContent(storage, authorizedDarkStorageId, context)
						: unavailableStoredContent(),
				}
			: {}),
	};
}

async function sanitizeEditorJson(
	storage: BodyBlobStorageReader,
	json: string | undefined,
	context: TemplateExportContext
): Promise<{ value: unknown; availability: Availability }> {
	if (json === undefined) return { value: null, availability: 'missing' };
	try {
		return {
			value: await sanitizeEditorValue(storage, JSON.parse(json), context),
			availability: 'available',
		};
	} catch (error) {
		if (error instanceof TemplateMediaLimitError) throw error;
		return { value: null, availability: 'corrupt' };
	}
}

async function transactionalAttachments(
	storage: BodyBlobStorageReader,
	json: string | undefined,
	context: TemplateExportContext
): Promise<{
	items: Array<Record<string, unknown>>;
	availability: Availability;
}> {
	if (json === undefined) return { items: [], availability: 'missing' };
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return { items: [], availability: 'corrupt' };
		const items: Array<Record<string, unknown>> = [];
		for (const candidate of parsed) {
			if (candidate === null || typeof candidate !== 'object') {
				items.push({
					contentBase64: '',
					contentEncoding: 'base64',
					availability: 'corrupt',
				});
				continue;
			}
			const attachment = candidate as Record<string, unknown>;
			const storageId =
				typeof attachment['storageId'] === 'string' ? attachment['storageId'] : undefined;
			const permittedStorageId = authorizedStorageId(
				context,
				attachment['mediaAssetId'],
				storageId
			);
			items.push({
				...(typeof attachment['id'] === 'string' ? { id: attachment['id'] } : {}),
				...(typeof attachment['filename'] === 'string' ? { filename: attachment['filename'] } : {}),
				...(typeof attachment['contentType'] === 'string'
					? { contentType: attachment['contentType'] }
					: {}),
				...(typeof attachment['fileSize'] === 'number' ? { fileSize: attachment['fileSize'] } : {}),
				...(permittedStorageId
					? await storedContent(storage, permittedStorageId, context)
					: {
							contentBase64: '',
							contentEncoding: 'base64',
							availability: 'missing',
						}),
			});
		}
		return { items, availability: 'available' };
	} catch (error) {
		if (error instanceof TemplateMediaLimitError) throw error;
		return { items: [], availability: 'corrupt' };
	}
}

export function projectEmailTemplateMetadata(template: Doc<'emailTemplates'>) {
	return {
		_id: template._id,
		_creationTime: template._creationTime,
		name: template.name,
		subject: template.subject,
		previewText: template.previewText,
		type: template.type,
		status: template.status,
		publishedAt: template.publishedAt,
		showUnsubscribe: template.showUnsubscribe,
		defaultLanguage: template.defaultLanguage,
		supportedLanguages: template.supportedLanguages,
		linkedBlockIds: template.linkedBlockIds,
		contentBlockVersion: template.contentBlockVersion,
		rendererVersion: template.rendererVersion,
		htmlRenderState: template.htmlRenderState,
		createdAt: template.createdAt,
		updatedAt: template.updatedAt,
	};
}

export function projectTransactionalEmailMetadata(template: Doc<'transactionalEmails'>) {
	return {
		_id: template._id,
		_creationTime: template._creationTime,
		name: template.name,
		slug: template.slug,
		subject: template.subject,
		dataVariablesSchema: template.dataVariablesSchema,
		status: template.status,
		publishedAt: template.publishedAt,
		showUnsubscribe: template.showUnsubscribe,
		defaultLanguage: template.defaultLanguage,
		supportedLanguages: template.supportedLanguages,
		linkedBlockIds: template.linkedBlockIds,
		contentBlockVersion: template.contentBlockVersion,
		rendererVersion: template.rendererVersion,
		attachmentsVersion: template.attachmentsVersion,
		translationsVersion: template.translationsVersion,
		sendCount: template.sendCount,
		htmlRenderState: template.htmlRenderState,
		createdAt: template.createdAt,
		updatedAt: template.updatedAt,
	};
}

export async function openEmailTemplateContent(
	storage: BodyBlobStorageReader,
	template: Doc<'emailTemplates'>,
	authorizedAssets: readonly AccountExportMediaAsset[] = []
) {
	const context: TemplateExportContext = {
		authorizedAssets: new Map(
			authorizedAssets.map((asset) => [asset.mediaAssetId, asset.storageId])
		),
		decodedMediaBytes: 0,
	};
	return {
		editorContent: await sanitizeEditorJson(storage, template.content, context),
		translations: await sanitizeEditorJson(storage, template.translations, context),
	};
}

export async function openTransactionalEmailContent(
	storage: BodyBlobStorageReader,
	template: Doc<'transactionalEmails'>,
	authorizedAssets: readonly AccountExportMediaAsset[] = []
) {
	const context: TemplateExportContext = {
		authorizedAssets: new Map(
			authorizedAssets.map((asset) => [asset.mediaAssetId, asset.storageId])
		),
		decodedMediaBytes: 0,
	};
	return {
		editorContent: await sanitizeEditorJson(storage, template.content, context),
		translations: await sanitizeEditorJson(storage, template.translations, context),
		attachments: await transactionalAttachments(storage, template.attachments, context),
	};
}

export function referencedTemplateMediaAssetIds(template: {
	content?: string;
	translations?: string;
	attachments?: string;
}): string[] {
	const ids = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== 'object') return;
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			if ((key === 'mediaAssetId' || key === 'darkMediaAssetId') && typeof nested === 'string') {
				ids.add(nested);
			} else {
				visit(nested);
			}
		}
	};
	for (const json of [template.content, template.translations, template.attachments]) {
		if (!json) continue;
		try {
			visit(JSON.parse(json));
		} catch {
			// The projection reports corrupt JSON; it must not authorize storage.
		}
	}
	return [...ids];
}
