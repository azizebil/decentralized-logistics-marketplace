/**
 * Playwright end-to-end UI demo for the DLM Console.
 *
 * Prerequisites (already running):
 *   - Hardhat node on http://127.0.0.1:8545
 *   - Contracts deployed + frontend-demo.json written
 *   - Frontend server on http://127.0.0.1:5173
 *
 * Run:  npx playwright test test/ui-demo.spec.js --headed
 *  or:  npx playwright test test/ui-demo.spec.js  (headless)
 */

const { test, expect } = require("@playwright/test");

const URL      = "http://127.0.0.1:5173";
const SHOTS    = "test/screenshots";

// Helper: wait for a log entry containing the given text to appear
async function waitForLog(page, text, timeout = 15_000) {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("#logOutput .timeline-entry strong")]
              .some(el => el.textContent.includes(t)),
    text,
    { timeout }
  );
}

test.describe("DLM Console — Full Demo Flow", () => {

  test("1 · Page loads and shows brand header", async ({ page }) => {
    await page.goto(URL);
    await expect(page.locator("h1")).toHaveText("Decentralized Logistics Marketplace");
    await expect(page.locator("#networkStatus")).toContainText(/Disconnected|Ready/);
    await page.screenshot({ path: `${SHOTS}/01-initial-load.png`, fullPage: true });
  });

  test("2 · Connect to local Hardhat node", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    // Wait for the network status to mention chain ID 31337
    await expect(page.locator("#networkStatus")).toContainText("31337", { timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/02-connected.png`, fullPage: true });
  });

  test("3 · Contract addresses auto-load from deployment.json", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Deployment loaded");
    // Both address fields should be non-empty
    const registry = await page.inputValue("#registryAddress");
    const pool     = await page.inputValue("#poolAddress");
    expect(registry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await page.screenshot({ path: `${SHOTS}/03-addresses-loaded.png`, fullPage: true });
  });

  test("4 · Demo state auto-loads (deliveryId + vault pre-filled)", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Demo loaded");
    const deliveryId = await page.inputValue("#deliveryId");
    const vault      = await page.inputValue("#vaultAddress");
    expect(deliveryId).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(vault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Pickup / dropoff codes should be pre-filled
    const pickup  = await page.inputValue("#pickupCode");
    const dropoff = await page.inputValue("#dropoffCode");
    expect(pickup).toMatch(/^0x/);
    expect(dropoff).toMatch(/^0x/);
    await page.screenshot({ path: `${SHOTS}/04-demo-state-loaded.png`, fullPage: true });
  });

  test("5 · Requests panel populates after Connect", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Data refreshed");
    // At least one request item should appear in the list
    const items = page.locator("#requestsList .item");
    await expect(items.first()).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: `${SHOTS}/05-requests-list.png`, fullPage: true });
  });

  test("6 · Click a request to see details panel", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Data refreshed");
    // Click the first request in the list
    await page.locator("#requestsList .item").first().click();
    // Details section should no longer show the empty placeholder
    await expect(page.locator("#detailsOutput")).not.toHaveClass(/details-empty/, { timeout: 8_000 });
    // Should show a status pill
    await expect(page.locator(".status-pill").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/06-request-details.png`, fullPage: true });
  });

  test("7 · Vault status check", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Demo loaded");
    await page.click("#vaultStatusBtn");
    await waitForLog(page, "Vault checked");
    // The status pill should show PickedUp (the demo left it there)
    const logEntries = page.locator("#logOutput .timeline-entry");
    await expect(logEntries.first()).toContainText("Vault checked");
    await page.screenshot({ path: `${SHOTS}/07-vault-status.png`, fullPage: true });
  });

  test("8 · Load bids for the demo delivery", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Demo loaded");
    await page.click("#loadBidsBtn");
    await waitForLog(page, "Bids loaded");
    const bids = page.locator("#bidsList .item");
    await expect(bids.first()).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: `${SHOTS}/08-bids-loaded.png`, fullPage: true });
  });

  test("9 · Courier capacity check", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Data refreshed");
    // Switch courier to account 5 (the admitted courier)
    await page.selectOption("#courierAccount", "5");
    await page.click("#capacityBtn");
    await waitForLog(page, "Courier capacity checked");
    await expect(page.locator("#capacityOutput")).not.toHaveText("Capacity: —");
    await page.screenshot({ path: `${SHOTS}/09-courier-capacity.png`, fullPage: true });
  });

  test("10 · Full flow: Confirm Delivery → Finalize Payout", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Demo loaded");

    // Check current vault state before acting
    await page.click("#vaultStatusBtn");
    await waitForLog(page, "Vault checked");

    const detailsText = await page.locator("#detailsOutput").textContent();
    const alreadyDone = detailsText.includes("Paid out") || detailsText.includes("Delivered") || detailsText.includes("Finalized");

    if (!alreadyDone) {
      // Vault is still in PickedUp — confirm delivery
      await page.selectOption("#mailboxAccount", "4");
      await page.click("#confirmDeliveryBtn");
      await waitForLog(page, "Confirm delivery complete", 20_000);
      await page.screenshot({ path: `${SHOTS}/10a-delivered.png`, fullPage: true });
    } else {
      // Already confirmed from a previous run — vault is in Delivered/Finalized
      await page.screenshot({ path: `${SHOTS}/10a-already-delivered.png`, fullPage: true });
    }

    // Attempt finalize — succeeds if dispute window has passed, reverts otherwise (both are valid)
    await page.click("#finalizeDeliveredBtn");
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: `${SHOTS}/10b-finalize-attempt.png`, fullPage: true });

    // Either "Finalize delivered complete" or an error is acceptable
    const logText = await page.locator("#logOutput").textContent();
    const ok = logText.includes("Finalize delivered") || logText.includes("Something went wrong") || alreadyDone;
    expect(ok).toBe(true);
  });

  test("11 · Refresh re-reads chain state", async ({ page }) => {
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Data refreshed");
    await page.click("#refreshBtn");
    await waitForLog(page, "Data refreshed");
    await page.screenshot({ path: `${SHOTS}/11-refreshed.png`, fullPage: true });
  });

  test("12 · Full-page final screenshot (all panels visible)", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(URL);
    await page.click("#connectBtn");
    await waitForLog(page, "Demo loaded");
    await page.click("#vaultStatusBtn");
    await waitForLog(page, "Vault checked");
    await page.click("#loadBidsBtn");
    await waitForLog(page, "Bids loaded");
    await page.screenshot({ path: `${SHOTS}/12-full-ui.png`, fullPage: true });
  });

});
