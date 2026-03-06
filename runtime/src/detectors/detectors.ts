import type { Page } from "playwright";

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body?.innerText ?? "").toLowerCase());
}

export async function detectLogin(page: Page): Promise<boolean> {
  const hasPasswordInput = await page.locator('input[type="password"]').count();
  if (hasPasswordInput > 0) {
    return true;
  }

  const text = await bodyText(page);
  return ["sign in", "log in", "войти", "вход"].some((marker) => text.includes(marker));
}

export async function detect2FA(page: Page): Promise<boolean> {
  const text = await bodyText(page);
  return ["verification code", "2-step", "otp", "код подтверждения"].some((marker) =>
    text.includes(marker),
  );
}

export async function detectCookiePopup(page: Page): Promise<boolean> {
  const buttons = page.locator("button");
  const count = await buttons.count();

  for (let i = 0; i < Math.min(count, 20); i += 1) {
    const text = (await buttons.nth(i).innerText()).toLowerCase();
    if (["accept", "i agree", "принять", "согласен"].some((marker) => text.includes(marker))) {
      return true;
    }
  }

  return false;
}

export async function handleCookiePopup(page: Page): Promise<boolean> {
  const buttons = page.locator("button");
  const count = await buttons.count();

  for (let i = 0; i < Math.min(count, 20); i += 1) {
    const locator = buttons.nth(i);
    const text = (await locator.innerText()).toLowerCase();
    if (["accept", "i agree", "принять", "согласен"].some((marker) => text.includes(marker))) {
      await locator.click();
      return true;
    }
  }

  return false;
}

export async function detectErrorBanner(page: Page): Promise<boolean> {
  const text = await bodyText(page);
  return ["something went wrong", "error", "try again", "ошибка"].some((marker) =>
    text.includes(marker),
  );
}
