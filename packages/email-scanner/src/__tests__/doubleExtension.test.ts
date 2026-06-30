import { describe, it, expect } from 'vitest';
import { detectDoubleExtension, isExecutableExtension } from '../files/doubleExtension.js';

describe('double extension detection', () => {
	describe('detectDoubleExtension', () => {
		it('detects invoice.pdf.exe', () => {
			const result = detectDoubleExtension('invoice.pdf.exe');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.pdf');
			expect(result.hiddenExtension).toBe('.exe');
			expect(result.executableExtension).toBe(true);
		});

		it('detects report.docx.js', () => {
			const result = detectDoubleExtension('report.docx.js');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.docx');
			expect(result.hiddenExtension).toBe('.js');
		});

		it('detects photo.jpg.scr', () => {
			const result = detectDoubleExtension('photo.jpg.scr');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.jpg');
			expect(result.hiddenExtension).toBe('.scr');
		});

		it('detects document.xlsx.bat', () => {
			const result = detectDoubleExtension('document.xlsx.bat');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.xlsx');
			expect(result.hiddenExtension).toBe('.bat');
		});

		it('detects image.png.vbs', () => {
			const result = detectDoubleExtension('image.png.vbs');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.png');
			expect(result.hiddenExtension).toBe('.vbs');
		});

		it('does not flag archive.tar.gz (both are archive-related)', () => {
			const result = detectDoubleExtension('archive.tar.gz');

			expect(result.detected).toBe(false);
		});

		it('does not flag normal single-extension files', () => {
			expect(detectDoubleExtension('document.pdf').detected).toBe(false);
			expect(detectDoubleExtension('photo.jpg').detected).toBe(false);
			expect(detectDoubleExtension('data.csv').detected).toBe(false);
		});

		it('does not flag files with no extension', () => {
			expect(detectDoubleExtension('README').detected).toBe(false);
		});

		it('detects triple extensions with executable end', () => {
			const result = detectDoubleExtension('file.doc.pdf.exe');

			expect(result.detected).toBe(true);
			expect(result.hiddenExtension).toBe('.exe');
		});

		it('is case-insensitive for extensions', () => {
			const result = detectDoubleExtension('invoice.PDF.EXE');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.pdf');
			expect(result.hiddenExtension).toBe('.exe');
		});

		it('detects mixed case: invoice.PDF.exe', () => {
			const result = detectDoubleExtension('invoice.PDF.exe');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.pdf');
			expect(result.hiddenExtension).toBe('.exe');
		});

		it('detects mixed case: report.EXE.pdf with non-executable final ext', () => {
			// .pdf is not executable, so this should NOT be detected
			const result = detectDoubleExtension('report.EXE.pdf');

			expect(result.detected).toBe(false);
		});

		it('detects mixed case: file.Exe.Pdf with non-executable final ext', () => {
			// .Pdf (pdf) is not executable, so this should NOT be detected
			const result = detectDoubleExtension('file.Exe.Pdf');

			expect(result.detected).toBe(false);
		});

		it('detects mixed case: document.pDf.ExE', () => {
			const result = detectDoubleExtension('document.pDf.ExE');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.pdf');
			expect(result.hiddenExtension).toBe('.exe');
			expect(result.executableExtension).toBe(true);
		});

		it('detects mixed case: photo.Jpg.Scr', () => {
			const result = detectDoubleExtension('photo.Jpg.Scr');

			expect(result.detected).toBe(true);
			expect(result.visibleExtension).toBe('.jpg');
			expect(result.hiddenExtension).toBe('.scr');
		});

		it('detects .ps1 (PowerShell) as executable', () => {
			const result = detectDoubleExtension('report.pdf.ps1');

			expect(result.detected).toBe(true);
			expect(result.hiddenExtension).toBe('.ps1');
		});

		it('detects .msi as executable', () => {
			const result = detectDoubleExtension('update.pdf.msi');

			expect(result.detected).toBe(true);
		});

		it('detects .iso as executable (disk images)', () => {
			const result = detectDoubleExtension('document.pdf.iso');

			expect(result.detected).toBe(true);
		});

		it('detects .lnk as executable (shortcuts)', () => {
			const result = detectDoubleExtension('readme.txt.lnk');

			expect(result.detected).toBe(true);
		});
	});

	describe('isExecutableExtension', () => {
		it('identifies .exe as executable', () => {
			expect(isExecutableExtension('file.exe')).toBe(true);
		});

		it('identifies .bat as executable', () => {
			expect(isExecutableExtension('script.bat')).toBe(true);
		});

		it('identifies .ps1 as executable', () => {
			expect(isExecutableExtension('script.ps1')).toBe(true);
		});

		it('identifies .jar as executable', () => {
			expect(isExecutableExtension('app.jar')).toBe(true);
		});

		it('does not identify .pdf as executable', () => {
			expect(isExecutableExtension('doc.pdf')).toBe(false);
		});

		it('does not identify .png as executable', () => {
			expect(isExecutableExtension('image.png')).toBe(false);
		});

		it('returns false for files with no extension', () => {
			expect(isExecutableExtension('README')).toBe(false);
		});

		it('is case-insensitive for executable check', () => {
			expect(isExecutableExtension('file.EXE')).toBe(true);
			expect(isExecutableExtension('script.BAT')).toBe(true);
			expect(isExecutableExtension('app.Jar')).toBe(true);
			expect(isExecutableExtension('run.Ps1')).toBe(true);
		});
	});
});
