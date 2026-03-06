import type { Page } from "playwright";

export type CalendarSurfaceCheck =
  | { ok: true }
  | {
      ok: false;
      code: "NOT_AUTHENTICATED" | "NOT_CALENDAR_SURFACE";
      reason: string;
      url: string;
    };

export async function checkCalendarSurface(page: Page): Promise<CalendarSurfaceCheck> {
  const url = page.url();

  if (/accounts\.google\.com/i.test(url)) {
    return {
      ok: false,
      code: "NOT_AUTHENTICATED",
      reason: "Redirected to Google Accounts login",
      url,
    };
  }

  if (/workspace\.google\.com\/intl\//i.test(url)) {
    return {
      ok: false,
      code: "NOT_CALENDAR_SURFACE",
      reason: "Redirected to marketing (workspace.google.com)",
      url,
    };
  }

  if (/support\.google\.com/i.test(url)) {
    return {
      ok: false,
      code: "NOT_CALENDAR_SURFACE",
      reason: "Redirected to support.google.com",
      url,
    };
  }

  if (!/calendar\.google\.com/i.test(url)) {
    return {
      ok: false,
      code: "NOT_CALENDAR_SURFACE",
      reason: "Not on calendar.google.com host",
      url,
    };
  }

  const appSurfaceDetected = await page.evaluate(() => {
    const hasCalendarLink = Boolean(document.querySelector("a[href*='/calendar/u/']"));
    const hasMain = Boolean(document.querySelector("[role='main']"));
    const hasCreate = Array.from(document.querySelectorAll("button,div,[role='button']")).some((element) => {
      const text = (element.textContent ?? "").trim().toLowerCase();
      return text === "создать" || text === "create";
    });

    return hasCalendarLink || (hasMain && hasCreate);
  }).catch(() => false);

  if (!appSurfaceDetected) {
    return {
      ok: false,
      code: "NOT_CALENDAR_SURFACE",
      reason: "calendar.google.com loaded, but app surface not detected",
      url,
    };
  }

  return { ok: true };
}
