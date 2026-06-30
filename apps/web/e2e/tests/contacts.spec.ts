import { test, expect } from '@playwright/test';
import path from 'node:path';
import { ContactsPage } from '../page-objects/ContactsPage';
import { SAMPLE_CONTACTS } from '../fixtures/test-data';

test.describe('Contacts Management', () => {
	let contactsPage: ContactsPage;

	test.beforeEach(async ({ page }) => {
		contactsPage = new ContactsPage(page);
		await contactsPage.goto();
	});

	test('add a contact via modal and see it in the table', async ({ page }) => {
		const contact = SAMPLE_CONTACTS[0];
		await contactsPage.addContact({
			email: contact.email,
			firstName: contact.firstName,
			lastName: contact.lastName,
		});

		// Verify contact appears in table
		await expect(contactsPage.tableRows.filter({ hasText: contact.email })).toBeVisible({
			timeout: 10_000,
		});
	});

	test('search contacts by email filters results', async ({ page }) => {
		// First add a contact to search for
		const contact = SAMPLE_CONTACTS[1];
		await contactsPage.addContact({ email: contact.email, firstName: contact.firstName });

		// Search for the contact
		await contactsPage.searchContacts(contact.email);

		// Should find the contact
		await expect(contactsPage.tableRows.filter({ hasText: contact.email })).toBeVisible({
			timeout: 10_000,
		});
	});

	test('CSV import uploads and shows preview', async ({ page }) => {
		const csvPath = path.resolve(__dirname, '../fixtures/csv-contacts.csv');
		const modal = await contactsPage.importCSV(csvPath);

		// Wait for file to be parsed and preview shown
		// The modal should move to mapping step after file upload
		await expect(modal.getByText(/Map columns|mapping/i)).toBeVisible({ timeout: 10_000 });
	});

	test('bulk selection shows selected count', async ({ page }) => {
		// Add a contact first
		await contactsPage.addContact({
			email: SAMPLE_CONTACTS[2].email,
			firstName: SAMPLE_CONTACTS[2].firstName,
		});

		// Wait for table to have rows
		await expect(contactsPage.tableRows.first()).toBeVisible({ timeout: 10_000 });

		// Click select all checkbox
		await contactsPage.selectAllCheckbox.click();

		// Verify selected count text appears
		await expect(contactsPage.selectedCountText).toBeVisible({ timeout: 5_000 });
	});
});
