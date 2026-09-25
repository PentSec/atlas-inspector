import { expect, test } from "@playwright/test";

test("serves the client shell", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Atlas Inspector/);
    await expect(page.locator("#fdid")).toBeVisible();
    await expect(page.locator("#go")).toBeVisible();
    await expect(page.locator("#cv")).toBeVisible();
});

test("api v1 health is reachable", async ({ request }) => {
    const res = await request.get("/api/v1/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
});