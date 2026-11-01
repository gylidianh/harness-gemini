/**
 * The one place the application's reported name lives.
 *
 * The service reports APP_NAME from /api/status, and every helper script that has to recognise
 * "our own service" (launch, stop, the import helpers, the desktop smoke check) compares against
 * the same constant. A rename that touches only one side used to make the launch and stop
 * scripts treat the app as a foreign service; importing the name from here makes that impossible.
 *
 * LEGACY_APP_NAMES are names written into process.json by older releases, so a run record left
 * behind by a previous version can still be stopped after an upgrade.
 */
export const APP_NAME = 'Harness Gemini';
export const LEGACY_APP_NAMES = Object.freeze(['Local Harness']);

/** True for the name the running service reports. */
export function isOwnService(status) {
  return Boolean(status) && typeof status === 'object' && status.appName === APP_NAME;
}

/** True for a run record written by this or an earlier release. */
export function isOwnRunRecord(record) {
  return Boolean(record) && typeof record === 'object'
    && (record.appName === APP_NAME || LEGACY_APP_NAMES.includes(record.appName));
}
