import { expect, test } from "@playwright/test";

test("renders the app shell and reaches the unreachable health state with no backend running", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "m3l console" }),
  ).toBeVisible();

  const banner = page.getByTestId("health-banner");
  await expect(banner).toContainText(/unreachable/i);
});
