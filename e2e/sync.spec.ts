import { mkdirSync } from 'node:fs';
import { expect, test as base, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalPageOverflow, expectWithinViewport, isTouchProject, openMap, stationLabel } from './helpers';
import { SYNC_APP_ORIGIN, SYNC_APP_URL, SYNC_SERVER_URL } from './ports';

/**
 * Backup & sync end to end (docs/sync-design.md, "Testing → E2E"): the app built with VITE_SYNC_URL, the real backup
 * server under `wrangler dev` with a fresh local database, and passkeys from Playwright's virtual authenticator. Each
 * browser context is one device; copying its passkeys to another context stands in for a password manager syncing them.
 * The virtual authenticator doesn't set the backup flags, so every passkey shows the "saved only on this device" warning.
 */

const RP_ID = 'localhost';
/** The scenarios run on an iPhone (WebKit) and a laptop (Chrome); layout and screenshots across phone, tablet and wide. */
const SCENARIO_PROJECTS = ['iphone-webkit', 'laptop-1280'];
const LAYOUT_PROJECTS = ['phone-375', 'phone-393', 'iphone-webkit', 'tablet-820', 'wide-1920'];

interface ErrorWatch {
  /** Page errors and console errors, except "Failed to load resource" answers a step said to expect. */
  readonly unexpected: string[];
  allowStatus(...statuses: number[]): void;
  /** For a device that goes offline: its requests fail without any answer. */
  allowNetworkFailures(): void;
}

interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
  errors: ErrorWatch;
}

function watchErrors(page: Page): ErrorWatch {
  const unexpected: string[] = [];
  const statuses = new Set<number>();
  let networkFailures = false;
  page.on('pageerror', (error) => unexpected.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const failedLoad = /^Failed to load resource: (.*)$/.exec(text);
    if (failedLoad) {
      const status = /status of (\d{3})/.exec(failedLoad[1] ?? '')?.[1];
      if (status ? statuses.has(Number(status)) : networkFailures) return;
    }
    // WebKit adds this for a cross-origin request that got no answer at all.
    if (networkFailures && /due to access control checks/.test(text)) return;
    unexpected.push(`console.error: ${text}`);
  });
  return {
    unexpected,
    allowStatus: (...allowed) => allowed.forEach((status) => statuses.add(status)),
    allowNetworkFailures: () => {
      networkFailures = true;
    }
  };
}

const test = base.extend<{ device: (name: string) => Promise<Device> }>({
  /** Opens a new device: its own browser context (storage and passkeys) with this project's viewport and theme. */
  device: async ({ browser, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, colorScheme }, use) => {
    const devices: Device[] = [];
    await use(async (name) => {
      const context = await browser.newContext({ baseURL: SYNC_APP_URL, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, colorScheme });
      await context.credentials.install();
      const page = await context.newPage();
      const device = { name, context, page, errors: watchErrors(page) };
      devices.push(device);
      return device;
    });
    for (const device of devices) await device.context.close();
  }
});

function onlyOn(projects: readonly string[]) {
  test.beforeEach(({ }, testInfo) => {
    test.skip(!projects.includes(testInfo.project.name), `runs on ${projects.join(', ')}`);
  });
}

async function press(locator: Locator, testInfo: TestInfo) {
  if (isTouchProject(testInfo)) await locator.tap();
  else await locator.click();
}

const section = (page: Page) => page.locator('section[data-backup-section]');
const heading = (page: Page) => page.getByRole('heading', { name: 'Backup & sync', level: 2 });
const liveRegion = (page: Page) => section(page).getByRole('status');
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });
const undoBar = (page: Page) => page.locator('[data-undo-bar]');
const announcements = (page: Page) => page.locator('[data-app-announcements]');
const button = (scope: Page | Locator, name: string | RegExp) => scope.getByRole('button', { name, exact: typeof name === 'string' });
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openApp(device: Device) {
  await openMap(device.page);
}

async function openTab(device: Device, name: 'Map' | 'Statistics' | 'Settings', testInfo: TestInfo) {
  await press(device.page.getByRole('navigation').getByRole('button', { name }), testInfo);
  if (name === 'Settings') await expect(heading(device.page)).toBeVisible();
}

/**
 * Records a journey through the app's storage, as if recorded earlier (so it can no longer be undone), and lets the
 * backup engine know.
 */
async function recordJourney(device: Device, from: string, to: string) {
  await device.page.evaluate(`(async () => {
    const network = await import('/src/data/network.ts');
    const storage = await import('/src/lib/storage.ts');
    const sync = await import('/src/lib/sync.ts');
    const { queued } = await storage.recordJourney(network.findRoute(${JSON.stringify(from)}, ${JSON.stringify(to)}));
    await storage.endUndoWindow();
    if (queued) sync.nudgeSync();
  })()`);
}

/**
 * Records a journey on the map, the way a user does. Then, unless `keepUndo`, dismisses the undo bar (keeping the
 * journey), which backs it up straight away rather than once it can no longer be undone.
 */
async function recordOnMap(device: Device, from: string, to: string, testInfo: TestInfo, { keepUndo = false } = {}) {
  await press(stationLabel(device.page, from), testInfo);
  await press(stationLabel(device.page, to), testInfo);
  const routeBar = device.page.locator('.route-action-bar');
  const record = routeBar.getByRole('button', { name: /^(Record route|Already explored)$/ });
  await expect(record).toBeVisible();
  const alreadyExplored = (await record.textContent()) === 'Already explored';
  await press(record, testInfo);
  if (alreadyExplored) await press(routeBar.getByRole('button', { name: 'Clear selection' }), testInfo);
  await expect(routeBar).toBeHidden();
  // An already-explored journey adds nothing here, so there's nothing to undo.
  if (alreadyExplored) return;
  await expect(undoBar(device.page)).toBeVisible();
  if (keepUndo) return;
  await press(button(undoBar(device.page), 'Dismiss'), testInfo);
  await expect(undoBar(device.page)).toBeHidden();
}

/** Undo ignores presses in its first 800 ms (UNDO_GUARD_MS: a double tap on “Record route” would land on it). */
async function pressUndo(device: Device, testInfo: TestInfo) {
  await device.page.waitForTimeout(900);
  await press(button(undoBar(device.page), 'Undo'), testInfo);
}

/** The app goes to the background (switching apps, locking the phone) or comes back. */
async function setHidden(device: Device, hidden: boolean) {
  await device.page.evaluate((value) => {
    if (value) Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    else delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/**
 * The server's next answer to `method` on a path matching `path` is 403 reauth_required, as it would be more than five
 * minutes after this device last used its passkey. The app then confirms it's you with a real passkey ceremony
 * against the real server (reauth/options and reauth/verify), and tries again. Returns the reauth/verify requests seen.
 */
async function requireReauthOnce(device: Device, method: 'POST' | 'DELETE', path: RegExp): Promise<string[]> {
  device.errors.allowStatus(403);
  const verified: string[] = [];
  device.page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/auth/reauth/verify') verified.push(request.url());
  });
  let answered = false;
  await device.page.route((url) => url.origin === SYNC_SERVER_URL && path.test(url.pathname), async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      // A CORS preflight, should the browser let it be routed: allow the real request.
      await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': SYNC_APP_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } });
      return;
    }
    if (answered || request.method() !== method) {
      await route.fallback();
      return;
    }
    answered = true;
    await route.fulfill({
      status: 403,
      headers: { 'Access-Control-Allow-Origin': SYNC_APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiVersion: 1, error: { code: 'reauth_required', message: 'Confirm it’s you with your passkey first.' } })
    });
  });
  return verified;
}

/** Every change this device sends to the backup, as the JSON bodies of its /v1/sync requests. */
function watchSyncRequests(device: Device): string[] {
  const bodies: string[] = [];
  device.page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/sync') bodies.push(request.postData() ?? '');
  });
  return bodies;
}

async function routeSections(device: Device, from: string, to: string): Promise<string[]> {
  return device.page.evaluate(`(async () => {
    const network = await import('/src/data/network.ts');
    return network.findRoute(${JSON.stringify(from)}, ${JSON.stringify(to)}).sections.map((section) => section.id).sort();
  })()`);
}

/** The track sections this device shows as travelled, sorted. */
async function travelled(device: Device): Promise<string[]> {
  return device.page.evaluate(`(async () => {
    const storage = await import('/src/lib/storage.ts');
    const record = await storage.db.progress.get('current');
    return [...(record?.value?.travelledSegmentIDs ?? [])].sort();
  })()`);
}

interface Summary { account: { name: string } | null; unsent: number; held: number; lastError: { code: string } | null; notice: { accountName: string } | null }

async function summary(device: Device): Promise<Summary> {
  return device.page.evaluate(`(async () => (await import('/src/lib/storage.ts')).readSyncSummary())()`);
}

/** Waits until everything this device queued has reached the backup. */
async function expectBackedUp(device: Device, timeout = 15_000) {
  await expect.poll(async () => {
    const { account, unsent, lastError } = await summary(device);
    return account !== null && unsent === 0 && lastError === null;
  }, { timeout }).toBe(true);
}

/** Copies every passkey on one device to another, as a password manager syncing them would (with their counters). */
async function copyPasskeys(from: Device, to: Device) {
  for (const { id, userHandle, privateKey, publicKey, signCount } of await from.context.credentials.get({ rpId: RP_ID })) {
    await to.context.credentials.delete(id);
    await to.context.credentials.create(RP_ID, { id, userHandle, privateKey, publicKey, signCount });
  }
}

/** Settings → Backup & sync → turn on, with or without the "restore instead?" step. Returns the backup's name. */
async function turnOnBackup(device: Device, testInfo: TestInfo): Promise<string> {
  await openTab(device, 'Settings', testInfo);
  const backup = section(device.page);
  await press(button(backup, 'Turn on backup'), testInfo);
  const start = button(backup, 'Start a new backup');
  if (await start.isVisible()) await press(start, testInfo);
  await expect(backup).toHaveAttribute('data-backup-section', 'on');
  await expectBackedUp(device);
  const { account } = await summary(device);
  return account!.name;
}

/** Settings → Backup & sync → restore, with passkeys copied from `from`. */
async function restoreBackup(device: Device, from: Device, testInfo: TestInfo) {
  await copyPasskeys(from, device);
  await openTab(device, 'Settings', testInfo);
  await press(button(section(device.page), /^Restore (from a backup|my backup)$/).first(), testInfo);
}

async function resetProgress(device: Device, accountName: string, testInfo: TestInfo) {
  await openTab(device, 'Settings', testInfo);
  await press(button(device.page, 'Reset progress'), testInfo);
  const confirm = device.page.getByRole('dialog', { name: 'Reset all progress?' });
  await expect(confirm).toContainText(`This permanently clears your recorded routes on this device and on every device using ${accountName}. It can’t be undone.`);
  await press(button(confirm, 'Reset progress'), testInfo);
  await expect(confirm).toBeHidden();
  await expect(button(device.page, 'Reset progress')).toBeFocused();
}

async function backUpNow(device: Device, testInfo: TestInfo) {
  await openTab(device, 'Settings', testInfo);
  await press(button(section(device.page), 'Back up now'), testInfo);
}

function expectNoErrors(...devices: Device[]) {
  for (const device of devices) expect(device.errors.unexpected, `errors on device ${device.name}`).toEqual([]);
}

test.describe('Backup & sync', () => {
  onlyOn(SCENARIO_PROJECTS);

  test('turning on with journeys offers to restore instead; a device with none restores them', async ({ device }, testInfo) => {
    const a = await device('A');
    await openApp(a);
    await recordJourney(a, 'paddington', 'waterloo');
    await openTab(a, 'Settings', testInfo);

    const backupA = section(a.page);
    await expect(backupA).toHaveAttribute('data-backup-section', 'off');
    await expect(backupA).toContainText('Back up your journeys so you can get them back if this browser’s data is cleared, and use them on your other devices.');
    await press(button(backupA, 'Turn on backup'), testInfo);
    const step = backupA.getByRole('group', { name: /Already backing up Tube Tracker on another device\?/ });
    await expect(step).toBeVisible();
    await expect(step.getByText(/^Already backing up/)).toBeFocused();
    await expect(button(step, 'Restore my backup')).toBeVisible();
    await press(button(step, 'Start a new backup'), testInfo);

    // Focus lands on the heading after turning on, and the result is announced.
    await expect(backupA).toHaveAttribute('data-backup-section', 'on');
    await expect(heading(a.page)).toBeFocused();
    await expect(liveRegion(a.page)).toHaveText('Backup turned on');
    await expectBackedUp(a);
    const { account } = await summary(a);
    const name = account!.name;
    expect(name).toMatch(/^Tube Tracker · [A-Z0-9]{4}$/);
    await expect(backupA).toContainText(`Backup: ${name}`);
    await expect(backupA).toContainText(`Keep the “${name}” passkey in your passwords app. Without it, this backup can’t be restored.`);
    await expect(backupA.locator('[data-backup-status]')).toHaveText(/^Backed up · (just now|1 minute ago)$/);
    // One passkey, which the virtual authenticator doesn't back up: the warning shows, and it can't be removed.
    const passkeys = backupA.getByRole('listitem');
    await expect(passkeys).toHaveCount(1);
    await expect(passkeys.first()).toContainText('Passkey');
    await expect(passkeys.first()).toContainText('This passkey is saved only on this device.');
    await expect(button(backupA, /^Remove/)).toHaveCount(0);

    // B has no journeys, so restoring comes first.
    const b = await device('B');
    await copyPasskeys(a, b);
    await openApp(b);
    await openTab(b, 'Settings', testInfo);
    const backupB = section(b.page);
    const restore = button(backupB, 'Restore from a backup');
    await expect(restore).toHaveAccessibleDescription('Backed up before, here or on another device?');
    await expect(button(backupB, 'Turn on backup')).toHaveAccessibleDescription('New to backup? Start one.');
    await press(restore, testInfo);
    await expect(backupB).toHaveAttribute('data-backup-section', 'on');
    await expect(heading(b.page)).toBeFocused();
    await expect(liveRegion(b.page)).toHaveText(`Restored ${name}`);
    await expect.poll(() => travelled(b)).toEqual(await routeSections(a, 'paddington', 'waterloo'));
    await expectBackedUp(b);
    expectNoErrors(a, b);
  });

  test('a journey recorded on one device reaches another with “Back up now”, when the app comes back and when it gets the focus', async ({ device }, testInfo) => {
    const a = await device('A');
    await openApp(a);
    await turnOnBackup(a, testInfo);
    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expectBackedUp(b);

    await openTab(a, 'Map', testInfo);
    await recordOnMap(a, 'paddington', 'waterloo', testInfo);
    await expectBackedUp(a);
    const first = await routeSections(a, 'paddington', 'waterloo');
    await backUpNow(b, testInfo);
    await expect.poll(() => travelled(b)).toEqual(first);
    await expect(liveRegion(b.page)).toHaveText('Backed up');

    await recordOnMap(a, 'bank', 'stratford', testInfo);
    await expectBackedUp(a);
    const both = [...new Set([...first, ...(await routeSections(a, 'bank', 'stratford'))])].sort();
    // B comes back to the app 10 seconds after its last sync (it checks again after 5).
    await b.page.evaluate(`(async () => {
      const storage = await import('/src/lib/storage.ts');
      await storage.db.sync.update('status', { lastSyncedAt: Date.now() - 10_000 });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await expect.poll(() => travelled(b)).toEqual(both);

    // Windows side by side on a computer: record in A, close its undo bar, then click straight into B's window (10
    // seconds after B's last sync). A sends as it loses the focus, before B checks.
    await b.page.evaluate(`(async () => {
      const storage = await import('/src/lib/storage.ts');
      await storage.db.sync.update('status', { lastSyncedAt: Date.now() - 10_000 });
    })()`);
    await recordOnMap(a, 'brixton', 'victoria', testInfo);
    await a.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await b.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const all = [...new Set([...both, ...(await routeSections(a, 'brixton', 'victoria'))])].sort();
    await expect.poll(() => travelled(b)).toEqual(all);
    expectNoErrors(a, b);
  });

  test('a reset on one device clears the other', async ({ device }, testInfo) => {
    const a = await device('A');
    await openApp(a);
    await recordJourney(a, 'paddington', 'waterloo');
    const name = await turnOnBackup(a, testInfo);
    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expect.poll(() => travelled(b)).not.toEqual([]);

    await resetProgress(b, name, testInfo);
    expect(await travelled(b)).toEqual([]);
    await expectBackedUp(b);
    await backUpNow(a, testInfo);
    await expect.poll(() => travelled(a)).toEqual([]);
    expectNoErrors(a, b);
  });

  test('a journey recorded offline over old track after another device’s reset is kept on both', async ({ device }, testInfo) => {
    const a = await device('A');
    await openApp(a);
    await recordJourney(a, 'paddington', 'waterloo');
    await recordJourney(a, 'bank', 'stratford');
    const name = await turnOnBackup(a, testInfo);
    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expectBackedUp(b);

    // A goes offline before it hears about B's reset, so it still shows both journeys.
    a.errors.allowNetworkFailures();
    await a.context.setOffline(true);
    await resetProgress(b, name, testInfo);
    await expectBackedUp(b);

    await openTab(a, 'Map', testInfo);
    await recordOnMap(a, 'paddington', 'waterloo', testInfo);
    await expect.poll(async () => (await summary(a)).unsent).toBe(1);
    await openTab(a, 'Settings', testInfo);
    await expect(section(a.page).locator('[data-backup-status]')).toHaveText('Waiting for a connection · your latest journeys are saved on this device');

    await a.context.setOffline(false);
    await expectBackedUp(a, 30_000);
    const paddingtonWaterloo = await routeSections(a, 'paddington', 'waterloo');
    // The reset cleared Bank to Stratford; the journey recorded after it stays, here and on B.
    await expect.poll(() => travelled(a)).toEqual(paddingtonWaterloo);
    await backUpNow(b, testInfo);
    await expect.poll(() => travelled(b)).toEqual(paddingtonWaterloo);
    expectNoErrors(a, b);
  });

  test('restoring on a device with old journeys after a reset asks first; “Don’t add them” leaves both empty', async ({ device }, testInfo) => {
    const b = await device('B');
    await openApp(b);
    await recordJourney(b, 'bank', 'stratford');
    const name = await turnOnBackup(b, testInfo);
    await resetProgress(b, name, testInfo);
    await expectBackedUp(b);

    const a = await device('A');
    await openApp(a);
    await recordJourney(a, 'paddington', 'waterloo');
    await restoreBackup(a, b, testInfo);
    const merge = dialog(a.page, 'Add this device’s journeys to your backup?');
    await expect(merge).toBeVisible();
    await expect(merge).toContainText(new RegExp(`This device has \\d+ track sections and \\d+ stations that aren’t in ${escapeRegExp(name)}\\.`));
    await expect(merge).toContainText(/Your backup was reset on \d{1,2} [A-Z][a-z]+ \d{4}, so some of these may be from before then\./);
    await expect(button(merge, 'Add them')).toBeFocused();
    await expect(button(merge, 'Don’t add them')).toHaveAccessibleDescription('This device will show your backup’s journeys instead.');

    // Escape cancels the restore: still off, and focus is back on the button that started it.
    await a.page.keyboard.press('Escape');
    await expect(merge).toBeHidden();
    await expect(section(a.page)).toHaveAttribute('data-backup-section', 'off');
    await expect(button(section(a.page), 'Restore from a backup')).toBeFocused();
    expect((await summary(a)).account).toBeNull();

    await press(button(section(a.page), 'Restore from a backup'), testInfo);
    await expect(merge).toBeVisible();
    await press(button(merge, 'Don’t add them'), testInfo);
    await expect(merge).toBeHidden();
    await expect(section(a.page)).toHaveAttribute('data-backup-section', 'on');
    await expect(heading(a.page)).toBeFocused();
    await expect(liveRegion(a.page)).toHaveText(`Restored ${name}`);
    await expect.poll(() => travelled(a)).toEqual([]);
    await expectBackedUp(a);
    await backUpNow(b, testInfo);
    await expect(liveRegion(b.page)).toHaveText('Backed up');
    expect(await travelled(b)).toEqual([]);
    expectNoErrors(a, b);
  });

  test('turning off keeps this device’s journeys; deleting the backup signs the other device out with a notice', async ({ device }, testInfo) => {
    const a = await device('A');
    await openApp(a);
    await recordJourney(a, 'paddington', 'waterloo');
    const name = await turnOnBackup(a, testInfo);
    const journey = await travelled(a);
    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expect.poll(() => travelled(b)).toEqual(journey);

    // Turn off on B: Cancel is focused first; journeys stay.
    await press(button(section(b.page), 'Turn off on this device'), testInfo);
    const turnOff = dialog(b.page, 'Turn off backup on this device?');
    await expect(turnOff).toContainText('Your backup and your other devices aren’t affected. Journeys stay on this device unless you remove them.');
    await expect(button(turnOff, 'Cancel')).toBeFocused();
    await expect(turnOff.getByRole('checkbox', { name: 'Also remove journeys from this device' })).not.toBeChecked();
    await press(button(turnOff, 'Turn off'), testInfo);
    await expect(turnOff).toBeHidden();
    await expect(section(b.page)).toHaveAttribute('data-backup-section', 'off');
    await expect(heading(b.page)).toBeFocused();
    await expect(liveRegion(b.page)).toHaveText('Backup turned off');
    expect(await travelled(b)).toEqual(journey);

    // B signs in again: its journeys are all in the backup, so there's nothing to ask.
    await press(button(section(b.page), 'Restore from a backup'), testInfo);
    await expect(section(b.page)).toHaveAttribute('data-backup-section', 'on');
    await expectBackedUp(b);

    // A deletes the backup (B's passkey copy has the newer counter, should A need to confirm it's them).
    await copyPasskeys(b, a);
    await press(button(section(a.page), 'Delete backup…'), testInfo);
    const remove = dialog(a.page, 'Delete your backup for all devices?');
    await expect(remove).toContainText(`This permanently deletes ${name} and its journeys from Tube Tracker’s server.`);
    await expect(button(remove, 'Cancel')).toBeFocused();
    await press(button(remove, 'Delete backup'), testInfo);
    await expect(remove).toBeHidden();
    await expect(section(a.page)).toHaveAttribute('data-backup-section', 'off');
    await expect(section(a.page)).toContainText(`You can also delete the “${name}” passkey in your passwords app.`);
    await expect(heading(a.page)).toBeFocused();
    await expect(liveRegion(a.page)).toHaveText('Backup deleted');
    expect(await travelled(a)).toEqual(journey);

    // B finds out on its next sync, and keeps its journeys.
    b.errors.allowStatus(401);
    await backUpNow(b, testInfo);
    const notice = `This device was signed out of backup ${name}. It may have been deleted on another device or not used for over a year. Your journeys are still on this device.`;
    await expect(section(b.page)).toHaveAttribute('data-backup-section', 'off');
    await expect(section(b.page)).toContainText(notice);
    expect(await travelled(b)).toEqual(journey);
    await openTab(b, 'Map', testInfo);
    const banner = b.page.locator('[data-sync-notice]');
    await expect(banner).toHaveRole('status');
    await expect(banner).toHaveText(new RegExp(`^${escapeRegExp(notice)}`));
    await press(button(banner, 'Backup settings'), testInfo);
    await expect(heading(b.page)).toBeFocused();
    await expect(banner).toBeHidden();
    await openTab(b, 'Map', testInfo);
    await press(button(banner, 'Dismiss'), testInfo);
    await expect(banner).toBeHidden();
    await openTab(b, 'Settings', testInfo);
    await expect(section(b.page)).not.toContainText('was signed out of backup');
    expectNoErrors(a, b);
  });

  test('closing the passkey window without a passkey is neutral', async ({ device }, testInfo) => {
    const a = await device('A');
    await openApp(a);
    await openTab(a, 'Settings', testInfo);
    await press(button(section(a.page), 'Restore from a backup'), testInfo);
    const note = section(a.page).locator('[data-note-tone]');
    await expect(note).toHaveText('No passkey was used. If no passkey window appeared, open Tube Tracker in Safari or Chrome and try again.');
    await expect(note).toHaveAttribute('data-note-tone', 'neutral');
    await expect(section(a.page)).toHaveAttribute('data-backup-section', 'off');
    await expect(button(section(a.page), 'Restore from a backup')).toBeEnabled();
    expectNoErrors(a);
  });

  test('passkeys: adding one, removing one and signing out other devices', async ({ device }, testInfo) => {
    const a = await device('A');
    await openApp(a);
    const name = await turnOnBackup(a, testInfo);
    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expectBackedUp(b);
    const backupA = section(a.page);

    // This password manager already holds the backup's passkey.
    await press(button(backupA, 'Add a passkey'), testInfo);
    await expect(backupA.locator('[data-note-tone]')).toHaveText('Your password manager here already has a passkey for this backup. To add another, pick a different option in the passkey window, such as another device or a security key.');

    // More than five minutes after A last used its passkey, adding one takes two taps: the first confirms it's you (with
    // B's copy of the passkey, which has the newer counter since B restored with it).
    await copyPasskeys(b, a);
    const addReauth = await requireReauthOnce(a, 'POST', /^\/v1\/passkeys\/options$/);
    await press(button(backupA, 'Add a passkey'), testInfo);
    const confirmed = 'That confirmed it’s you. Tap “Add a passkey” again to save the new passkey.';
    await expect(backupA.locator('[data-note-tone]')).toHaveText(confirmed);
    await expect(liveRegion(a.page)).toHaveText(confirmed);
    expect(addReauth).toHaveLength(1);
    await expect(backupA.getByRole('listitem')).toHaveCount(1);

    // A different password manager: a second passkey, and now either can be removed.
    const [original] = await a.context.credentials.get({ rpId: RP_ID });
    await a.context.credentials.delete(original!.id);
    await press(button(backupA, 'Add a passkey'), testInfo);
    await expect(liveRegion(a.page)).toHaveText('Passkey added');
    await expect(backupA.getByRole('listitem')).toHaveCount(2);
    await expect(button(backupA, /^Remove Passkey, added /)).toHaveCount(2);

    // Removing the original passkey signs out B, which was using it. Not recently verified, it confirms it's you (with
    // the new passkey) in the same tap.
    const removeReauth = await requireReauthOnce(a, 'DELETE', /^\/v1\/passkeys\/[^/]+$/);
    await press(button(backupA, /^Remove Passkey, added /).first(), testInfo);
    const removePasskey = dialog(a.page, 'Remove this passkey?');
    await expect(button(removePasskey, 'Cancel')).toBeFocused();
    await press(button(removePasskey, 'Remove passkey'), testInfo);
    await expect(removePasskey).toBeHidden();
    await expect(liveRegion(a.page)).toHaveText('Passkey removed');
    expect(removeReauth).toHaveLength(1);
    await expect(backupA.getByRole('listitem')).toHaveCount(1);
    await expect(heading(a.page)).toBeFocused();

    b.errors.allowStatus(401, 404);
    await backUpNow(b, testInfo);
    await expect(section(b.page)).toHaveAttribute('data-backup-section', 'off');
    await expect(section(b.page)).toContainText(`This device was signed out of backup ${name}.`);
    // B only has the removed passkey.
    await press(button(section(b.page), 'Restore from a backup'), testInfo);
    await expect(section(b.page).locator('[data-note-tone]')).toHaveText('That passkey isn’t linked to a backup any more.');

    await press(button(backupA, 'Sign out other devices'), testInfo);
    const signOut = dialog(a.page, 'Sign out your other devices?');
    await expect(signOut).toContainText(`Every other device using ${name} stops backing up and keeps the journeys it already has.`);
    await press(button(signOut, 'Sign out other devices'), testInfo);
    await expect(signOut).toBeHidden();
    await expect(liveRegion(a.page)).toHaveText('Other devices signed out');
    await expect(button(backupA, 'Sign out other devices')).toBeFocused();
    expectNoErrors(a, b);
  });
});

test.describe('Backup & sync: timed undo', () => {
  onlyOn(SCENARIO_PROJECTS);

  test('a journey undone within its window never reaches the backup; another device restores without it', async ({ device }, testInfo) => {
    const a = await device('A');
    const requests = watchSyncRequests(a);
    await openApp(a);
    await recordJourney(a, 'bank', 'stratford');
    const bankStratford = await routeSections(a, 'bank', 'stratford');
    await turnOnBackup(a, testInfo);

    await openTab(a, 'Map', testInfo);
    await recordOnMap(a, 'paddington', 'waterloo', testInfo, { keepUndo: true });
    await expect(undoBar(a.page)).toHaveAccessibleName('Journey recorded');
    await expect(announcements(a.page)).toHaveText('Journey recorded');
    // It waits on this device while it can be undone: the status stays “backed up”, and says why.
    expect(await summary(a)).toMatchObject({ unsent: 1 });
    await openTab(a, 'Settings', testInfo);
    await expect(section(a.page).locator('[data-backup-status]')).toHaveText(/^Backed up · (just now|1 minute ago)$/);
    await expect(section(a.page).locator('[data-backup-undo-wait]')).toHaveText('Your latest journey backs up once it can no longer be undone.');
    // It hasn't been backed up, so turning off offers to back it up first.
    await press(button(section(a.page), 'Turn off on this device'), testInfo);
    const turnOff = dialog(a.page, 'Turn off backup on this device?');
    await expect(turnOff).toContainText('Some journeys on this device haven’t been backed up yet.');
    await expect(button(turnOff, 'Back up first')).toBeVisible();
    await press(button(turnOff, 'Cancel'), testInfo);
    await expect(turnOff).toBeHidden();

    // Back on the map the bar is still there.
    await openTab(a, 'Map', testInfo);
    await pressUndo(a, testInfo);
    await expect(undoBar(a.page)).toBeHidden();
    await expect(announcements(a.page)).toHaveText('Journey removed');
    // The journey's start and end are selected again, so the right route can be picked straight away.
    await expect(a.page.locator('.route-action-bar')).toContainText('Paddington → Waterloo');
    expect(await travelled(a)).toEqual(bankStratford);
    expect(await summary(a)).toMatchObject({ unsent: 0 });
    await openTab(a, 'Settings', testInfo);
    await expect(section(a.page).locator('[data-backup-undo-wait]')).toHaveCount(0);
    await backUpNow(a, testInfo);
    await expect(liveRegion(a.page)).toHaveText('Backed up');

    // The server never received it, so a second device restores only what was kept.
    const paddingtonWaterloo = await routeSections(a, 'paddington', 'waterloo');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((body) => paddingtonWaterloo.some((id) => body.includes(`"${id}"`)))).toEqual([]);
    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expect(section(b.page)).toHaveAttribute('data-backup-section', 'on');
    await expectBackedUp(b);
    expect(await travelled(b)).toEqual(bankStratford);
    expectNoErrors(a, b);
  });

  test('leaving the app ends the window, so the journey is backed up straight away', async ({ device }, testInfo) => {
    const a = await device('A');
    const requests = watchSyncRequests(a);
    await openApp(a);
    await turnOnBackup(a, testInfo);
    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expectBackedUp(b);

    await openTab(a, 'Map', testInfo);
    await recordOnMap(a, 'paddington', 'waterloo', testInfo, { keepUndo: true });
    const journey = await routeSections(a, 'paddington', 'waterloo');
    expect(await summary(a)).toMatchObject({ unsent: 1 });
    const sentBefore = requests.length;

    // The phone is locked, or another app opened: a hidden page may get no more time to run, so it's sent now.
    await setHidden(a, true);
    await expectBackedUp(a);
    expect(requests.slice(sentBefore).some((body) => journey.every((id) => body.includes(`"${id}"`)))).toBe(true);
    await setHidden(a, false);
    await expect(undoBar(a.page)).toBeHidden();
    expect(await travelled(a)).toEqual(journey);

    await backUpNow(b, testInfo);
    await expect.poll(() => travelled(b)).toEqual(journey);
    expectNoErrors(a, b);
  });

  test('a journey kept past its window is backed up then', async ({ device }, testInfo) => {
    const a = await device('A');
    // This device's clock is Playwright's, so the five minutes can pass at once. It runs normally until then.
    await a.context.clock.install();
    await openApp(a);
    await turnOnBackup(a, testInfo);
    await openTab(a, 'Map', testInfo);
    await recordOnMap(a, 'paddington', 'waterloo', testInfo, { keepUndo: true });
    const journey = await routeSections(a, 'paddington', 'waterloo');
    expect(await travelled(a)).toEqual(journey);

    await a.context.clock.fastForward('04:50');
    await expect(undoBar(a.page)).toBeVisible();
    expect(await summary(a)).toMatchObject({ unsent: 1 });

    await a.context.clock.fastForward('00:11');
    await expect(undoBar(a.page)).toBeHidden();
    await expectBackedUp(a);
    expect(await travelled(a)).toEqual(journey);

    const b = await device('B');
    await openApp(b);
    await restoreBackup(b, a, testInfo);
    await expect.poll(() => travelled(b)).toEqual(journey);
    expectNoErrors(a, b);
  });
});

test.describe('Backup & sync on iPhone Safari', () => {
  onlyOn(['iphone-webkit']);

  test('the install pop-up and Settings say how to bring journeys to the Home Screen app', async ({ device }, testInfo) => {
    const a = await device('A');
    await openMap(a.page, { installPrompt: 'default' });
    await recordJourney(a, 'paddington', 'waterloo');
    const popup = a.page.getByRole('dialog', { name: 'Install Tube Tracker' });
    await expect(popup).toContainText('The Home Screen app keeps its own data. To bring your journeys across, turn on Backup & sync in Settings here, then choose “Restore from a backup” in the app.');
    await a.page.evaluate(`(async () => (await import('/src/lib/sync.ts')).getSyncActions().turnOn())()`);
    await expect(popup).toContainText('The Home Screen app keeps its own data. Your journeys are backed up: in the app, open Settings and choose “Restore from a backup”.');
    await press(button(popup, 'Close'), testInfo);
    await openTab(a, 'Settings', testInfo);
    await expect(a.page.getByText('so journeys recorded in Safari won’t appear in it until you restore your backup there.')).toBeVisible();

    // With backup off there's no backup to restore yet, so Settings says how to start one.
    const b = await device('B');
    await openApp(b);
    await recordJourney(b, 'bank', 'stratford');
    await openTab(b, 'Settings', testInfo);
    await expect(b.page.getByText('so journeys recorded in Safari won’t appear in it unless you turn on Backup & sync above, then restore your backup in the app.')).toBeVisible();
    expectNoErrors(a, b);
  });
});

test.describe('Backup & sync availability', () => {
  onlyOn(SCENARIO_PROJECTS);

  test('a build without a backup server shows nothing about it', async ({ page }, testInfo) => {
    await openMap(page);
    await press(page.getByRole('navigation').getByRole('button', { name: 'Settings' }), testInfo);
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Backup & sync' })).toHaveCount(0);
    await expect(page.getByText('Your progress is stored only on this device (in IndexedDB)')).toBeVisible();
    await expect(page.getByText('Privacy details')).toHaveCount(0);
  });

  test('a browser without passkeys is told backup isn’t available', async ({ device }, testInfo) => {
    const a = await device('A');
    await a.context.addInitScript(() => {
      delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    });
    await openApp(a);
    await openTab(a, 'Settings', testInfo);
    await expect(section(a.page)).toContainText('This browser can’t use passkeys, so backup isn’t available here.');
    await expect(button(section(a.page), /Turn on backup|Restore/)).toHaveCount(0);
    await expect(a.page.getByText('Your progress is stored only on this device (in IndexedDB)')).toBeVisible();
    expectNoErrors(a);
  });
});

/** Screenshots for review (test-results/screens/sync/), with overflow and tap-target checks at each step. */
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`Backup & sync layout, ${colorScheme}`, () => {
    onlyOn(LAYOUT_PROJECTS);
    test.use({ colorScheme });

    test('off, on and every dialog', async ({ device }, testInfo) => {
      test.setTimeout(120_000);
      const dir = `test-results/screens/sync/${testInfo.project.name}`;
      mkdirSync(dir, { recursive: true });
      const shot = async (target: Page | Locator, step: string) => {
        const page = 'page' in target ? target.page() : target;
        await expectNoHorizontalPageOverflow(page);
        await target.screenshot({ path: `${dir}/${colorScheme}-${step}.png`, animations: 'disabled' });
      };
      /** Every button in view is at least 44 px each way. */
      const expectTapTargets = async (scope: Locator) => {
        for (const control of await scope.getByRole('button').all()) {
          if (!(await control.isVisible())) continue;
          const box = await control.boundingBox();
          expect(box, `${await control.textContent()} should be rendered`).not.toBeNull();
          expect(box!.height, `${await control.textContent()} height`).toBeGreaterThanOrEqual(44);
          expect(box!.width, `${await control.textContent()} width`).toBeGreaterThanOrEqual(44);
        }
      };

      const a = await device('A');
      await openApp(a);
      await recordJourney(a, 'paddington', 'waterloo');
      await openTab(a, 'Settings', testInfo);
      const backupA = section(a.page);
      await backupA.scrollIntoViewIfNeeded();
      await expectTapTargets(backupA);
      await shot(backupA, '01-off');
      // The privacy line links to the details in Settings → About.
      await expect(backupA).toContainText('and when each signed-in device last connected.');
      await press(backupA.getByRole('link', { name: 'Privacy details' }), testInfo);
      const privacy = a.page.locator('#privacy-details');
      await expect(privacy).toHaveAttribute('open', '');
      await expect(privacy).toContainText('Sign-ins unused for 400 days are deleted.');
      await shot(privacy, '01b-privacy-details');
      await press(button(backupA, 'Turn on backup'), testInfo);
      await expectTapTargets(backupA);
      await shot(backupA, '02-off-restore-instead');
      await press(button(backupA, 'Start a new backup'), testInfo);
      await expect(backupA).toHaveAttribute('data-backup-section', 'on');
      await expectBackedUp(a);
      await expect(backupA.getByRole('listitem')).toHaveCount(1);
      await expectTapTargets(backupA);
      await shot(backupA, '03-on');

      // Not recently verified: the first tap on “Add a passkey” confirms it's you.
      await requireReauthOnce(a, 'POST', /^\/v1\/passkeys\/options$/);
      await press(button(backupA, 'Add a passkey'), testInfo);
      await expect(backupA.locator('[data-note-tone="info"]')).toHaveText('That confirmed it’s you. Tap “Add a passkey” again to save the new passkey.');
      await expectTapTargets(backupA);
      await shot(backupA, '03b-on-confirmed-its-you');

      const [original] = await a.context.credentials.get({ rpId: RP_ID });
      await a.context.credentials.delete(original!.id);
      await press(button(backupA, 'Add a passkey'), testInfo);
      await expect(backupA.getByRole('listitem')).toHaveCount(2);
      await expectTapTargets(backupA);
      await shot(backupA, '04-on-two-passkeys');

      const dialogShot = async (opener: Locator, title: string, step: string) => {
        await press(opener, testInfo);
        const open = dialog(a.page, title);
        await expect(open).toBeVisible();
        await expectTapTargets(open);
        await expectWithinViewport(a.page, open, title);
        await shot(a.page, step);
        await press(button(open, 'Cancel'), testInfo);
        await expect(open).toBeHidden();
        // Focus goes back to the button that opened it.
        await expect(opener).toBeFocused();
      };
      await dialogShot(button(backupA, /^Remove Passkey, added /).first(), 'Remove this passkey?', '05-dialog-remove-passkey');
      await dialogShot(button(backupA, 'Sign out other devices'), 'Sign out your other devices?', '06-dialog-sign-out-others');
      await dialogShot(button(backupA, 'Delete backup…'), 'Delete your backup for all devices?', '07-dialog-delete');

      // Offline with a journey not yet backed up: the turn-off dialog offers to back up first.
      a.errors.allowNetworkFailures();
      await a.context.setOffline(true);
      await recordJourney(a, 'bank', 'stratford');
      await expect(backupA.locator('[data-backup-status]')).toHaveText('Waiting for a connection · your latest journeys are saved on this device');
      await shot(backupA, '08-on-offline');
      await press(button(backupA, 'Turn off on this device'), testInfo);
      const turnOff = dialog(a.page, 'Turn off backup on this device?');
      await expect(turnOff).toContainText('Some journeys on this device haven’t been backed up yet.');
      await expect(button(turnOff, 'Back up first')).toBeVisible();
      await expectTapTargets(turnOff);
      await expectWithinViewport(a.page, turnOff, 'turn-off dialog');
      await shot(a.page, '09-dialog-turn-off');
      await press(button(turnOff, 'Cancel'), testInfo);
      await press(button(a.page, 'Reset progress'), testInfo);
      const reset = a.page.getByRole('dialog', { name: 'Reset all progress?' });
      await expect(reset).toContainText('Your other devices will clear when this one is back online.');
      await expect(button(reset, 'Cancel')).toBeFocused();
      await expectWithinViewport(a.page, reset, 'reset dialog');
      await shot(a.page, '10-dialog-reset');
      await press(button(reset, 'Cancel'), testInfo);
      await expect(reset).toBeHidden();
      await expect(button(a.page, 'Reset progress')).toBeFocused();
      await a.context.setOffline(false);
      await expectBackedUp(a, 30_000);

      // B has a journey the backup lacks.
      const b = await device('B');
      await openApp(b);
      await recordJourney(b, 'brixton', 'victoria');
      await restoreBackup(b, a, testInfo);
      const merge = dialog(b.page, 'Add this device’s journeys to your backup?');
      await expect(merge).toBeVisible();
      await expectTapTargets(merge);
      await expectWithinViewport(b.page, merge, 'restore dialog');
      await shot(b.page, '11-dialog-restore');
      await press(button(merge, 'Add them'), testInfo);
      await expect(section(b.page)).toHaveAttribute('data-backup-section', 'on');
      await expectBackedUp(b);

      await press(button(backupA, 'Delete backup…'), testInfo);
      await press(button(dialog(a.page, 'Delete your backup for all devices?'), 'Delete backup'), testInfo);
      await expect(backupA).toHaveAttribute('data-backup-section', 'off');
      await shot(backupA, '12-off-after-delete');

      b.errors.allowStatus(401);
      await backUpNow(b, testInfo);
      await expect(section(b.page)).toHaveAttribute('data-backup-section', 'off');
      await shot(section(b.page), '13-off-signed-out');
      await openTab(b, 'Map', testInfo);
      const banner = b.page.locator('[data-sync-notice]');
      await expect(banner).toBeVisible();
      await expectTapTargets(banner);
      await expectWithinViewport(b.page, banner, 'signed-out notice');
      // In the page's flow under the tabs: it covers neither them nor the title, and the map still fits below it.
      const nav = await b.page.getByRole('navigation').boundingBox();
      const bannerBox = await banner.boundingBox();
      const mapCard = await b.page.locator('.map-card').boundingBox();
      expect(bannerBox!.y, 'notice below the tabs').toBeGreaterThanOrEqual(nav!.y + nav!.height - 1);
      expect(mapCard!.y, 'map below the notice').toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height - 1);
      for (const name of ['Map', 'Statistics', 'Settings']) {
        const tab = await b.page.getByRole('navigation').getByRole('button', { name }).boundingBox();
        const onTop = await b.page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('button')?.textContent ?? null, [tab!.x + tab!.width / 2, tab!.y + tab!.height / 2]);
        expect(onTop, `${name} tab is uncovered`).toBe(name);
      }
      expect(await b.page.locator('.tube-map-viewport').evaluate((element) => element.clientHeight), 'map height').toBeGreaterThan(200);
      await shot(b.page, '14-signed-out-notice');
      expectNoErrors(a, b);
    });

    test('the undo bar, and the status while a journey can still be undone', async ({ device }, testInfo) => {
      const dir = `test-results/screens/sync/${testInfo.project.name}`;
      mkdirSync(dir, { recursive: true });
      const a = await device('A');
      await openApp(a);
      await turnOnBackup(a, testInfo);
      await openTab(a, 'Map', testInfo);
      await recordOnMap(a, 'paddington', 'waterloo', testInfo, { keepUndo: true });
      const bar = undoBar(a.page);
      await expectWithinViewport(a.page, bar, 'undo bar');
      for (const control of await bar.getByRole('button').all()) {
        const box = await control.boundingBox();
        expect(box!.height, 'undo bar button height').toBeGreaterThanOrEqual(44);
        expect(box!.width, 'undo bar button width').toBeGreaterThanOrEqual(44);
      }
      await expectNoHorizontalPageOverflow(a.page);
      await a.page.screenshot({ path: `${dir}/${colorScheme}-15-undo-bar.png`, animations: 'disabled' });

      await openTab(a, 'Settings', testInfo);
      const backupA = section(a.page);
      await expect(backupA.locator('[data-backup-undo-wait]')).toBeVisible();
      await backupA.scrollIntoViewIfNeeded();
      await expectNoHorizontalPageOverflow(a.page);
      await backupA.screenshot({ path: `${dir}/${colorScheme}-16-on-undo-wait.png`, animations: 'disabled' });
      expectNoErrors(a);
    });
  });
}
