import type { Page } from "playwright";

export interface DomElement {
  id: number;
  tag: string;
  text?: string;
  aria?: string;
  role?: string;
  href?: string;
}

export interface DomSnapshot {
  url: string;
  title: string;
  elements: DomElement[];
}

export async function captureDomSnapshot(page: Page): Promise<DomSnapshot> {
  const result = await page.evaluate(() => {
    const elements: Array<{
      id: number;
      tag: string;
      text?: string;
      aria?: string;
      role?: string;
      href?: string;
    }> = [];

    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a, button, [role='button'], input, textarea, [contenteditable='true']",
      ),
    ).slice(0, 40);

    nodes.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      element.setAttribute("data-agent-id", String(index));

      const textContent = (element.textContent ?? "").trim();
      const aria = element.getAttribute("aria-label")?.trim();
      const role = element.getAttribute("role")?.trim();
      const href = element instanceof HTMLAnchorElement ? element.href : undefined;

      elements.push({
        id: index,
        tag: element.tagName.toLowerCase(),
        text: textContent.length > 0 ? textContent : undefined,
        aria: aria && aria.length > 0 ? aria : undefined,
        role: role && role.length > 0 ? role : undefined,
        href: href && href.length > 0 ? href : undefined,
      });
    });

    return {
      title: document.title,
      url: location.href,
      elements,
    };
  });

  return result;
}
