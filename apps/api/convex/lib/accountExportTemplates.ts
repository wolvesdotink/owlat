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

async function storedContent(
	storage: BodyBlobStorageReader,
	storageId: string
): Promise<StoredContent> {
	const opened = await readSealedBlobBytesForExport(storage, storageId as Id<'_storage'>);
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
	value: unknown
): Promise<unknown> {
	if (Array.isArray(value)) {
		return Promise.all(value.map((item) => sanitizeEditorValue(storage, item)));
	}
	if (value === null || typeof value !== 'object') return value;

	const source = value as Record<string, unknown>;
	const storageId = typeof source['storageId'] === 'string' ? source['storageId'] : undefined;
	const darkStorageId =
		typeof source['darkStorageId'] === 'string' ? source['darkStorageId'] : undefined;
	const hasPrimaryImage = storageId !== undefined || typeof source['src'] === 'string';
	const hasDarkImage = darkStorageId !== undefined || typeof source['darkSrc'] === 'string';
	const entries = await Promise.all(
		Object.entries(source)
			.filter(
				([key]) =>
					key !== 'storageId' &&
					key !== 'darkStorageId' &&
					key !== 'mediaAssetId' &&
					key !== 'src' &&
					key !== 'darkSrc' &&
					key !== 'srcset' &&
					(!storageId || key !== 'url')
			)
			.map(async ([key, nested]) => [key, await sanitizeEditorValue(storage, nested)] as const)
	);
	return {
		...Object.fromEntries(entries),
		...(hasPrimaryImage
			? {
					storedContent: storageId
						? await storedContent(storage, storageId)
						: unavailableStoredContent(),
				}
			: {}),
		...(hasDarkImage
			? {
					darkStoredContent: darkStorageId
						? await storedContent(storage, darkStorageId)
						: unavailableStoredContent(),
				}
			: {}),
	};
}

async function sanitizeEditorJson(
	storage: BodyBlobStorageReader,
	json: string | undefined
): Promise<{ value: unknown; availability: Availability }> {
	if (json === undefined) return { value: null, availability: 'missing' };
	try {
		return {
			value: await sanitizeEditorValue(storage, JSON.parse(json)),
			availability: 'available',
		};
	} catch {
		return { value: null, availability: 'corrupt' };
	}
}

async function transactionalAttachments(
	storage: BodyBlobStorageReader,
	json: string | undefined
): Promise<{
	items: Array<Record<string, unknown>>;
	availability: Availability;
}> {
	if (json === undefined) return { items: [], availability: 'missing' };
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return { items: [], availability: 'corrupt' };
		const items = await Promise.all(
			parsed.map(async (candidate): Promise<Record<string, unknown>> => {
				if (candidate === null || typeof candidate !== 'object') {
					return {
						contentBase64: '',
						contentEncoding: 'base64',
						availability: 'corrupt',
					};
				}
				const attachment = candidate as Record<string, unknown>;
				const storageId =
					typeof attachment['storageId'] === 'string' ? attachment['storageId'] : undefined;
				return {
					...(typeof attachment['id'] === 'string' ? { id: attachment['id'] } : {}),
					...(typeof attachment['filename'] === 'string'
						? { filename: attachment['filename'] }
						: {}),
					...(typeof attachment['contentType'] === 'string'
						? { contentType: attachment['contentType'] }
						: {}),
					...(typeof attachment['fileSize'] === 'number'
						? { fileSize: attachment['fileSize'] }
						: {}),
					...(storageId
						? await storedContent(storage, storageId)
						: {
								contentBase64: '',
								contentEncoding: 'base64',
								availability: 'missing',
							}),
				};
			})
		);
		return { items, availability: 'available' };
	} catch {
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
	template: Doc<'emailTemplates'>
) {
	return {
		editorContent: await sanitizeEditorJson(storage, template.content),
		translations: await sanitizeEditorJson(storage, template.translations),
	};
}

export async function openTransactionalEmailContent(
	storage: BodyBlobStorageReader,
	template: Doc<'transactionalEmails'>
) {
	return {
		editorContent: await sanitizeEditorJson(storage, template.content),
		translations: await sanitizeEditorJson(storage, template.translations),
		attachments: await transactionalAttachments(storage, template.attachments),
	};
}
