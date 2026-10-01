// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ANSWER_UPLOAD_ACCEPT, isAcceptedAnswerUpload, pickAnswerFile } from '../answerFilePicker';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ANSWER_UPLOAD_ACCEPT', () => {
	const accepted = ANSWER_UPLOAD_ACCEPT.split(',');

	it('takes photos and PDFs, by type and by extension', () => {
		expect(accepted).toEqual(
			expect.arrayContaining(['image/jpeg', 'image/png', 'application/pdf', '.pdf', '.jpg'])
		);
	});

	it('names image types instead of image/*, so iOS hands a HEIC photo over as JPEG', () => {
		expect(accepted).not.toContain('image/*');
		expect(accepted.some((entry) => entry.includes('heic') || entry.includes('heif'))).toBe(false);
	});

	it('takes the documents a reply is asked for', () => {
		expect(accepted).toEqual(expect.arrayContaining(['.docx', '.xlsx', 'text/csv']));
	});
});

describe('isAcceptedAnswerUpload', () => {
	it('accepts by MIME type or, when the type is missing or generic, by name', () => {
		expect(isAcceptedAnswerUpload({ name: 'scan.jpg', type: 'image/jpeg' })).toBe(true);
		expect(isAcceptedAnswerUpload({ name: 'Invoice-4471.PDF', type: '' })).toBe(true);
		expect(isAcceptedAnswerUpload({ name: 'figures.xlsx', type: 'application/octet-stream' })).toBe(
			true
		);
	});

	it('refuses what the upload policy would refuse', () => {
		expect(isAcceptedAnswerUpload({ name: 'IMG_0042.HEIC', type: 'image/heic' })).toBe(false);
		expect(isAcceptedAnswerUpload({ name: 'logo.svg', type: 'image/svg+xml' })).toBe(false);
		expect(isAcceptedAnswerUpload({ name: 'setup.exe', type: 'application/x-msdownload' })).toBe(
			false
		);
	});
});

describe('pickAnswerFile', () => {
	function spyOnInput() {
		const created: HTMLInputElement[] = [];
		const create = document.createElement.bind(document);
		vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
			const el = create(tag);
			if (tag === 'input') {
				created.push(el as HTMLInputElement);
				vi.spyOn(el as HTMLInputElement, 'click').mockImplementation(() => {});
			}
			return el;
		}) as typeof document.createElement);
		return created;
	}

	it('opens a file picker with the accepted types and never forces the camera', () => {
		const created = spyOnInput();
		void pickAnswerFile();
		const input = created[0]!;
		expect(input.type).toBe('file');
		expect(input.accept).toBe(ANSWER_UPLOAD_ACCEPT);
		expect(input.hasAttribute('capture')).toBe(false);
		expect(input.multiple).toBe(false);
		expect(input.click).toHaveBeenCalledOnce();
	});

	it('resolves with the chosen file', async () => {
		const created = spyOnInput();
		const picked = pickAnswerFile();
		const file = new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });
		Object.defineProperty(created[0]!, 'files', { value: [file] });
		created[0]!.dispatchEvent(new Event('change'));
		await expect(picked).resolves.toBe(file);
	});

	it('resolves with nothing when the picker is closed empty', async () => {
		const created = spyOnInput();
		const picked = pickAnswerFile();
		created[0]!.dispatchEvent(new Event('cancel'));
		await expect(picked).resolves.toBeNull();
	});
});
