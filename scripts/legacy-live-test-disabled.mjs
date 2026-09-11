// Deliberately fail before importing production configuration, creating files,
// or contacting an existing app. A localhost app can still spend real money.
// No environment variable or --live flag can turn an unmetered entry into a
// budgeted one. Migrate it to the shared paid-test-entry boundary first.
throw new Error('Unbudgeted live test disabled. Use npm test for local regressions. Paid validation must use a reviewed budgeted runner with explicit --live and the existing cumulative authorization ledger; this legacy entry cannot opt in.')
