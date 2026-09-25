import { expect, test } from "@playwright/test";

test("serves the client shell", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Atlas Inspector/);
    await expect(page.locator("#fdid")).toBeVisible();
    await expect(page.locator("#go")).toBeVisible();
    await expect(page.locator("#cv")).toBeVisible();
});

test("scan tab swaps to its own panel", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#scanPanel")).toBeHidden();
    await page.locator("#mScan").click();
    await expect(page.locator("#scanPanel")).toBeVisible();
    await expect(page.locator("#fdid")).toBeHidden();
    await expect(page.locator("#mScan")).toHaveAttribute("aria-selected", "true");
    await page.locator("#mInspect").click();
    await expect(page.locator("#scanPanel")).toBeHidden();
    await expect(page.locator("#fdid")).toBeVisible();
});

test("page does not overflow the viewport", async ({ page }) => {
    for (const viewport of [
        { width: 1440, height: 900 },
        { width: 600, height: 800 },
    ]) {
        await page.setViewportSize(viewport);
        await page.goto("/");
        const dims = await page.evaluate(() => ({
            scrollH: document.documentElement.scrollHeight,
            innerH: window.innerHeight,
        }));
        expect(dims.scrollH).toBeLessThanOrEqual(dims.innerH + 1);
    }
});

test("api v1 health is reachable", async ({ request }) => {
    const res = await request.get("/api/v1/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
});