import type { OutboundMessage, StateEvent } from "@agent/shared";
import type { Locator, Page } from "playwright";

import type { RuntimeConfig } from "../config.js";
import { requiresApproval } from "../safety/safetyGate.js";
import { createLogEvent } from "../utils/logger.js";
import { captureDomSnapshot } from "./domSnapshot.js";
import type { Step } from "./steps.js";

const RETRY_DELAYS_MS = [500, 1500];
const MAX_RETRIES = 2;
const GENERIC_EDITABLE_SELECTOR = ":is(textarea:not([disabled]), [contenteditable='true'], [role='textbox'], input:not([disabled]):not([type]), input:not([disabled])[type='text'], input:not([disabled])[type='search'], input:not([disabled])[type='email'], input:not([disabled])[type='url'], input:not([disabled])[type='tel'], input:not([disabled])[type='password'], input:not([disabled])[type='number']):visible";
const CALENDAR_TEXT_INPUT_SELECTOR = "input:not([disabled]):not([readonly]):not([type='checkbox']):not([type='radio']):not([type='hidden']):not([type='button']):not([type='submit'])";

export class StepExecutionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepExecutionFailedError";
  }
}

export class ExecutionAbortedError extends Error {
  constructor(message = "Execution aborted") {
    super(message);
    this.name = "ExecutionAbortedError";
  }
}

export interface StepExecutorDriver {
  goto(url: string, timeoutMs?: number): Promise<void>;
  getCurrentUrl(): string;
  waitForSelector(selector: string, timeout?: number): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  waitForText(text: string, timeout?: number): Promise<void>;
  getPage(): Page;
}

interface ExecutorEmitter {
  emit(message: OutboundMessage): void;
}

interface ExecuteStepsOptions {
  driver: StepExecutorDriver;
  config: RuntimeConfig;
  emitter: ExecutorEmitter;
  steps: Step[];
  shouldAbort?: () => boolean;
  waitForApproval?: () => Promise<boolean>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown step error";
}

function isGoogleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("google.");
  } catch {
    return false;
  }
}

function toState(step: Step, message: string): StateEvent {
  return {
    type: "STATE",
    status: "RUNNING",
    step: step.type,
    message,
  };
}

function describeStep(step: Step): string {
  switch (step.type) {
    case "OPEN_URL":
      return `Open ${step.url}`;
    case "GOOGLE_SEARCH":
      return `Search Google for '${step.query}'`;
    case "CLICK_FIRST_RESULT":
      return "Click the first Google result";
    case "CLICK":
      if (step.elementId !== undefined) {
        return `Click elementId '${step.elementId}'`;
      }
      return step.selector ? `Click selector '${step.selector}'` : `Click text '${step.text ?? ""}'`;
    case "TYPE":
      return `Type '${step.text}'`;
    case "WAIT_FOR_SELECTOR":
      return `Wait for selector '${step.selector}'`;
    case "WAIT_NAVIGATION":
      return "Wait navigation";
    case "SET_EVENT_DATE":
      return `Set event date '${step.date}'`;
    case "SET_EVENT_START":
      return `Set event start '${step.time}'`;
    case "SET_EVENT_END":
      return `Set event end '${step.time}'`;
    case "SAVE_EVENT":
      return "Save event";
    case "PRESS":
      return `Press '${step.key}'`;
    case "SCROLL":
      return `Scroll ${step.deltaY}`;
    case "EXTRACT":
      return step.selector ? `Extract ${step.kind} from '${step.selector}'` : `Extract ${step.kind}`;
    case "WAIT_FOR_TEXT":
      return `Wait for text '${step.text}'`;
    case "SNAPSHOT":
      return "Capture DOM snapshot";
  }
}

function getCurrentUrlSafe(driver: StepExecutorDriver): string | undefined {
  try {
    return driver.getCurrentUrl();
  } catch {
    return undefined;
  }
}

function isGenericEditableSelector(selector: string): boolean {
  const normalized = selector.toLowerCase().replace(/\s+/g, "");
  if (/назв|title|subject|summary|addtitle|добавьтеназвание/.test(normalized)) {
    return false;
  }
  if (normalized === ":focus") {
    return false;
  }

  return normalized.includes("contenteditable")
    || normalized.includes("textbox")
    || normalized.includes("input")
    || normalized.includes("textarea");
}

function isTitleSelectorHint(selector: string): boolean {
  return /назв|title|subject|summary|add title|добавьте название/i.test(selector);
}

function stripVisiblePseudo(selector: string): string {
  return selector.replace(/:visible\b/gi, "").replace(/\s{2,}/g, " ").trim();
}

async function clickWithOverlayFallback(
  locator: Locator,
  timeout: number,
  emitter: ExecutorEmitter,
): Promise<void> {
  try {
    await locator.click({ timeout });
    return;
  } catch (error) {
    emitter.emit(createLogEvent("warn", "Click blocked by overlay, trying JS click"));

    try {
      await locator.evaluate((element) => {
        (element as { click: () => void }).click();
      });
      return;
    } catch {
      throw error;
    }
  }
}

async function hasTypedText(
  locator: Locator,
  text: string,
  options?: { exact?: boolean },
): Promise<boolean> {
  const expected = text.trim();
  if (expected.length === 0) {
    return true;
  }

  try {
    return await locator.evaluate((element, payload) => {
      const normalizeLoose = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const normalizeExact = (value: string) => value.replace(/\s+/g, " ").trim();
      const wantedLoose = normalizeLoose(payload.expectedText);
      const wantedExact = normalizeExact(payload.expectedText);
      const exact = payload.exact === true;

      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const currentValue = element.value ?? "";
        if (exact) {
          return normalizeExact(currentValue) === wantedExact;
        }
        return normalizeLoose(currentValue).includes(wantedLoose);
      }

      const host = element as HTMLElement;
      const raw = host.innerText || host.textContent || "";
      if (exact) {
        return normalizeExact(raw) === wantedExact;
      }
      return normalizeLoose(raw).includes(wantedLoose);
    }, {
      expectedText: expected,
      exact: options?.exact === true,
    });
  } catch {
    return false;
  }
}

async function waitForTypedText(
  locator: Locator,
  text: string,
  options?: {
    initialDelayMs?: number;
    attempts?: number;
    intervalMs?: number;
    exact?: boolean;
  },
): Promise<boolean> {
  const initialDelayMs = options?.initialDelayMs ?? 0;
  const attempts = options?.attempts ?? 1;
  const intervalMs = options?.intervalMs ?? 0;

  if (initialDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
  }

  for (let index = 0; index < attempts; index += 1) {
    if (await hasTypedText(locator, text, { exact: options?.exact })) {
      return true;
    }

    if (index < attempts - 1 && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return false;
}

async function shouldUseKeyboardTyping(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((element) => {
      const html = element as HTMLElement;
      const role = (html.getAttribute("role") ?? "").toLowerCase();
      return html.isContentEditable || html.getAttribute("contenteditable") === "true" || role === "textbox";
    });
  } catch {
    return false;
  }
}

async function isNativeEditable(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((element) => {
      const html = element as HTMLElement;
      const tag = html.tagName.toLowerCase();
      const role = (html.getAttribute("role") ?? "").toLowerCase();
      if (html.isContentEditable || html.getAttribute("contenteditable") === "true") {
        return true;
      }
      if (role === "textbox") {
        return true;
      }

      if (tag === "textarea") {
        const textarea = html as HTMLTextAreaElement;
        return !textarea.disabled && !textarea.readOnly;
      }

      if (tag === "input") {
        const input = html as HTMLInputElement;
        const type = (input.type || "text").toLowerCase();
        const textLike = type === "text"
          || type === "search"
          || type === "email"
          || type === "url"
          || type === "tel"
          || type === "password"
          || type === "number";
        return textLike && !input.disabled && !input.readOnly;
      }

      return false;
    });
  } catch {
    return false;
  }
}

async function resolveEditableTarget(locator: Locator): Promise<Locator> {
  if (await isNativeEditable(locator)) {
    return locator;
  }

  const marked = await locator.evaluate((element) => {
    const root = element as HTMLElement;
    root
      .querySelectorAll("[data-agent-resolved-editable='1']")
      .forEach((candidate) => candidate.removeAttribute("data-agent-resolved-editable"));

    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>(
        ":is([contenteditable='true'], [role='textbox'], textarea:not([disabled]), input:not([disabled]):not([type]), input:not([disabled])[type='text'], input:not([disabled])[type='search'], input:not([disabled])[type='email'], input:not([disabled])[type='url'], input:not([disabled])[type='tel'], input:not([disabled])[type='password'], input:not([disabled])[type='number'])",
      ),
    );

    let best: HTMLElement | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const style = window.getComputedStyle(candidate);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }

      const role = (candidate.getAttribute("role") ?? "").toLowerCase();
      const aria = (candidate.getAttribute("aria-label") ?? "").toLowerCase();
      const placeholder = (candidate.getAttribute("placeholder") ?? "").toLowerCase();
      const name = (candidate.getAttribute("name") ?? "").toLowerCase();
      const tag = candidate.tagName.toLowerCase();
      const inputType = (candidate.getAttribute("type") ?? "").toLowerCase();
      const haystack = `${aria} ${placeholder} ${name}`.trim();
      const isContentEditable = candidate.isContentEditable || candidate.getAttribute("contenteditable") === "true";

      if (role === "combobox") {
        continue;
      }
      if (/guest|гост|людей|people/.test(haystack)) {
        continue;
      }

      let score = 0;

      if (isContentEditable) {
        score += 220;
      }
      if (role === "textbox") {
        score += 180;
      }
      if (/назв|title|subject|summary/.test(haystack)) {
        score += 120;
      }
      if (/search|поиск|find/.test(haystack) || name === "q") {
        score -= 250;
      }
      if ((tag === "input" || tag === "textarea") && !/назв|title/.test(haystack)) {
        score -= 120;
      }
      if (tag === "input" && inputType && !/^(text|search|email|url|tel|password|number)$/.test(inputType)) {
        score -= 500;
      }
      if ((candidate as HTMLInputElement).readOnly) {
        score -= 300;
      }

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best) {
      return false;
    }

    best.setAttribute("data-agent-resolved-editable", "1");
    return true;
  });

  if (marked) {
    const ranked = locator.locator("[data-agent-resolved-editable='1']").first();
    await ranked.waitFor({ timeout: 2000, state: "visible" });
    return ranked;
  }

  const fallback = locator
    .locator(GENERIC_EDITABLE_SELECTOR)
    .first();
  await fallback.waitFor({ timeout: 2000, state: "visible" });
  return fallback;
}

async function isActiveOn(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((element) => {
      const active = document.activeElement;
      if (!active) {
        return false;
      }

      return element === active || element.contains(active);
    });
  } catch {
    return false;
  }
}

type CalendarFieldKind = "startDate" | "startTime" | "endTime";

function normalizeForExactMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForLooseMatch(value: string): string {
  return normalizeForExactMatch(value).toLowerCase();
}

function formatTimeWithMinutes(hours: number, minutes: number): string {
  const normalizedHours = ((hours % 24) + 24) % 24;
  return `${String(normalizedHours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function plusOneHour(time: string): string {
  const parsed = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!parsed) {
    return time;
  }

  const hours = Number(parsed[1]);
  const minutes = Number(parsed[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return time;
  }

  return formatTimeWithMinutes(hours + 1, minutes);
}

function parseCalendarDateTimeInput(value: string): { date: string; start: string; end: string } | null {
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T]+(\d{1,2}:\d{2})$/);
  if (!match) {
    return null;
  }

  const date = match[1];
  const startRaw = match[2];
  const startMatch = startRaw.match(/^(\d{1,2}):(\d{2})$/);
  if (!startMatch) {
    return null;
  }

  const startHours = Number(startMatch[1]);
  const startMinutes = Number(startMatch[2]);
  if (!Number.isFinite(startHours) || !Number.isFinite(startMinutes)) {
    return null;
  }
  if (startHours < 0 || startHours > 23 || startMinutes < 0 || startMinutes > 59) {
    return null;
  }

  const start = formatTimeWithMinutes(startHours, startMinutes);
  return {
    date,
    start,
    end: plusOneHour(start),
  };
}

function isCalendarUrl(url: string): boolean {
  return /calendar\.google\.com/i.test(url);
}

function isTitleFieldHint(meta: {
  ariaLabel: string;
  placeholder: string;
  name: string;
}): boolean {
  const haystack = `${meta.ariaLabel} ${meta.placeholder} ${meta.name}`.toLowerCase();
  return /назв|title|subject|summary/.test(haystack);
}

async function readLocatorTextValue(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value ?? "";
    }

    const html = element as HTMLElement;
    return html.innerText || html.textContent || "";
  });
}

async function tryOpenCalendarDetails(
  page: Page,
  timeout: number,
  emitter: ExecutorEmitter,
): Promise<void> {
  const dateLikeCount = await page
    .locator(
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='дата' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='date' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='дата' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='date' i], [role='textbox'][aria-label*='дата' i], [role='textbox'][aria-label*='date' i]):visible`,
    )
    .count();
  const timeLikeCount = await page
    .locator(
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='время' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='time' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='время' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='time' i], [role='textbox'][aria-label*='время' i], [role='textbox'][aria-label*='time' i]):visible`,
    )
    .count();
  const hasSeparateFields = dateLikeCount >= 1 && timeLikeCount >= 1;

  if (hasSeparateFields) {
    return;
  }

  const detailLocators = [
    page.getByRole("button", { name: /дополнительные параметры|подробнее|more options|more|details|edit event/i }).first(),
    page.getByText(/дополнительные параметры|подробнее|more options|details/i).first(),
  ];

  for (const locator of detailLocators) {
    try {
      await clickWithOverlayFallback(locator, Math.min(3000, timeout), emitter);
      await page.waitForTimeout(300);
      return;
    } catch {
      // Try next locator.
    }
  }
}

async function resolveCalendarFieldLocator(
  page: Page,
  kind: CalendarFieldKind,
  timeout: number,
): Promise<Locator> {
  const selectorCandidates: Record<CalendarFieldKind, string[]> = {
    startDate: [
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='дата' i][aria-label*='начал' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='start' i][aria-label*='date' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='дата' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='date' i], [role='textbox'][aria-label*='дата' i], [role='textbox'][aria-label*='date' i]):visible`,
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='дата' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='date' i]):visible`,
    ],
    startTime: [
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='время' i][aria-label*='начал' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='start' i][aria-label*='time' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='время' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*='time' i], [role='textbox'][aria-label*='время' i][aria-label*='начал' i], [role='textbox'][aria-label*='start' i][aria-label*='time' i]):visible`,
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='время' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='time' i], [role='textbox'][aria-label*='time' i], [role='textbox'][aria-label*='время' i]):visible`,
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[value*=':'], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*=':' i], [role='textbox'][aria-label*=':' i]):visible`,
    ],
    endTime: [
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='время' i][aria-label*='оконч' i], ${CALENDAR_TEXT_INPUT_SELECTOR}[aria-label*='end' i][aria-label*='time' i], [role='textbox'][aria-label*='время' i][aria-label*='оконч' i], [role='textbox'][aria-label*='end' i][aria-label*='time' i]):visible`,
      `:is(${CALENDAR_TEXT_INPUT_SELECTOR}[value*=':'], ${CALENDAR_TEXT_INPUT_SELECTOR}[placeholder*=':' i], [role='textbox'][aria-label*=':' i]):visible`,
    ],
  };

  const isUsable = async (locator: Locator): Promise<boolean> => {
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      return false;
    }
    const enabled = await locator.isEnabled().catch(() => false);
    if (!enabled) {
      return false;
    }
    const aria = (await locator.getAttribute("aria-label").catch(() => "") ?? "").toLowerCase();
    const placeholder = (await locator.getAttribute("placeholder").catch(() => "") ?? "").toLowerCase();
    const name = (await locator.getAttribute("name").catch(() => "") ?? "").toLowerCase();
    const role = (await locator.getAttribute("role").catch(() => "") ?? "").toLowerCase();
    const type = (await locator.getAttribute("type").catch(() => "") ?? "").toLowerCase();
    if (type && !/^(text|search|email|url|tel|password|number)$/.test(type)) {
      return false;
    }
    const haystack = `${aria} ${placeholder} ${name}`;
    if (/поиск|search|guest|гост|людей|people|where|где|location|место/.test(haystack)) {
      return false;
    }
    if (role === "combobox" && /поиск|search|guest|гост|людей|people/.test(haystack)) {
      return false;
    }
    return true;
  };

  if (kind === "endTime") {
    const resolvedFromStart = await page.evaluate(() => {
      document
        .querySelectorAll("[data-agent-resolved-end-time='1']")
        .forEach((element) => element.removeAttribute("data-agent-resolved-end-time"));

      const isVisible = (element: HTMLElement): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };

      const isTextLikeInput = (element: HTMLElement): boolean => {
        const tag = element.tagName.toLowerCase();
        if (tag === "textarea") {
          const textarea = element as HTMLTextAreaElement;
          return !textarea.disabled && !textarea.readOnly;
        }
        if (tag === "input") {
          const input = element as HTMLInputElement;
          const type = (input.type || "text").toLowerCase();
          const textLike = !type
            || type === "text"
            || type === "search"
            || type === "email"
            || type === "url"
            || type === "tel"
            || type === "password"
            || type === "number";
          return textLike && !input.disabled && !input.readOnly;
        }
        const role = (element.getAttribute("role") ?? "").toLowerCase();
        return element.isContentEditable
          || element.getAttribute("contenteditable") === "true"
          || role === "textbox";
      };

      const start = document.querySelector<HTMLElement>("[data-agent-calendar-start-time='1']");
      if (!start || !isVisible(start)) {
        return false;
      }

      const root = start.closest("[role='dialog'], [aria-modal='true'], form, .modal, .popover")
        ?? start.parentElement
        ?? document.body;

      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>("input, textarea, [contenteditable='true'], [role='textbox']"),
      );

      let best: HTMLElement | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const candidate of candidates) {
        if (candidate === start || start.contains(candidate)) {
          continue;
        }
        if (!isVisible(candidate) || !isTextLikeInput(candidate)) {
          continue;
        }

        const aria = (candidate.getAttribute("aria-label") ?? "").toLowerCase();
        const placeholder = (candidate.getAttribute("placeholder") ?? "").toLowerCase();
        const name = (candidate.getAttribute("name") ?? "").toLowerCase();
        const role = (candidate.getAttribute("role") ?? "").toLowerCase();
        const haystack = `${aria} ${placeholder} ${name}`;

        if (/поиск|search|guest|гост|людей|people|where|где|location|место/.test(haystack)) {
          continue;
        }
        if (role === "combobox" && /поиск|search|guest|гост|людей|people/.test(haystack)) {
          continue;
        }

        let score = 0;
        if (/время|time/.test(haystack)) {
          score += 40;
        }
        if (/оконч|end/.test(haystack)) {
          score += 120;
        }
        if (candidate.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING) {
          score += 20;
        }

        const startRect = start.getBoundingClientRect();
        const candidateRect = candidate.getBoundingClientRect();
        const dx = Math.abs(candidateRect.left - startRect.left);
        const dy = Math.abs(candidateRect.top - startRect.top);
        score -= Math.min(120, Math.round(dx / 8) + Math.round(dy / 8));

        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      if (!best) {
        return false;
      }

      best.setAttribute("data-agent-resolved-end-time", "1");
      return true;
    });

    if (resolvedFromStart) {
      const fromStart = page.locator("[data-agent-resolved-end-time='1']").first();
      await fromStart.waitFor({ timeout, state: "visible" });
      if (await isUsable(fromStart)) {
        return fromStart;
      }
    }
  }

  for (const selector of selectorCandidates[kind]) {
    const candidateList = page.locator(selector);
    const count = await candidateList.count();
    if (count === 0) {
      continue;
    }

    const first = candidateList.first();
    if (await isUsable(first)) {
      return first;
    }
  }

  const genericFallback = page.locator(GENERIC_EDITABLE_SELECTOR).first();
  await genericFallback.waitFor({ timeout, state: "visible" });
  return genericFallback;
}

async function setLocatorValueExact(
  page: Page,
  locator: Locator,
  value: string,
  timeout: number,
): Promise<void> {
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

  const verifyExact = async (): Promise<boolean> => {
    const current = await readLocatorTextValue(locator).catch(() => "");
    return normalizeForExactMatch(current) === normalizeForExactMatch(value);
  };

  const clearAndType = async (): Promise<void> => {
    await locator.click({ timeout: Math.min(3000, timeout) });
    await locator.evaluate((element) => {
      (element as HTMLElement).focus();
    }).catch(() => undefined);
    await page.keyboard.press(selectAllShortcut).catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);

    const useKeyboard = await shouldUseKeyboardTyping(locator);
    if (useKeyboard) {
      await page.keyboard.type(value);
    } else {
      await locator.fill(value, { timeout });
    }
  };

  const forceDomInsert = async (): Promise<void> => {
    await locator.evaluate((element, nextValue) => {
      const html = element as HTMLElement;
      html.focus();

      if (html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement) {
        html.value = nextValue;
      } else if (html.isContentEditable || html.getAttribute("contenteditable") === "true") {
        html.textContent = nextValue;
      }

      if (typeof InputEvent === "function") {
        html.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: nextValue,
        }));
      } else {
        html.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      }

      html.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await clearAndType();
    await page.waitForTimeout(150);
    if (await verifyExact()) {
      return;
    }

    await forceDomInsert();
    await page.waitForTimeout(120);
    if (await verifyExact()) {
      return;
    }
  }

  throw new Error(`Exact value was not applied: '${value}'`);
}

async function setCalendarFieldExact(
  page: Page,
  kind: CalendarFieldKind,
  value: string,
  timeout: number,
  emitter: ExecutorEmitter,
): Promise<void> {
  if (!isCalendarUrl(page.url())) {
    throw new Error("Calendar field actions require Google Calendar page");
  }

  await tryOpenCalendarDetails(page, timeout, emitter);
  const locator = await resolveCalendarFieldLocator(page, kind, timeout);
  if (kind === "startTime") {
    await locator.evaluate((element) => {
      document
        .querySelectorAll("[data-agent-calendar-start-time='1']")
        .forEach((node) => node.removeAttribute("data-agent-calendar-start-time"));
      (element as HTMLElement).setAttribute("data-agent-calendar-start-time", "1");
    }).catch(() => undefined);
  }
  await setLocatorValueExact(page, locator, value, timeout);
  const readback = await readLocatorTextValue(locator).catch(() => "");
  emitter.emit(createLogEvent("info", `Calendar ${kind} readback: '${String(readback).trim()}'`));
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(150);
}

async function saveCalendarEvent(
  page: Page,
  _timeout: number,
  emitter: ExecutorEmitter,
): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: /сохран/i }).first(),
    page.getByRole("button", { name: /save/i }).first(),
    page.getByRole("button", { name: /готов/i }).first(),
    page.getByRole("button", { name: /done/i }).first(),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (count === 0) {
      continue;
    }

    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    try {
      await candidate.click({ timeout: 300 });
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 300, force: true });
        return true;
      } catch {
        // Try next candidate.
      }
    }
  }

  emitter.emit(createLogEvent("warn", "Save button not found, sending Enter fallback"));
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(200);
  return true;
}

async function runStep(
  step: Step,
  driver: StepExecutorDriver,
  config: RuntimeConfig,
  emitter: ExecutorEmitter,
): Promise<string | undefined> {
  switch (step.type) {
    case "OPEN_URL": {
      await driver.goto(step.url, step.timeoutMs ?? config.navigationTimeoutMs);
      return `Opened ${step.url}`;
    }

    case "GOOGLE_SEARCH": {
      const page = driver.getPage();

      const waitForResults = async (): Promise<void> => {
        // 1) заголовки результатов
        const h3 = page.locator("a h3:visible").first();
        if (await h3.count()) {
          await h3.waitFor({ timeout: 15000, state: "visible" });
          return;
        }

        // 2) контейнер поиска
        const searchRoot = page.locator("#search:visible").first();
        if (await searchRoot.count()) {
          await searchRoot.waitFor({ timeout: 15000, state: "visible" });
          return;
        }

        // 3) любой линк в #search
        const any = page.locator("div#search a[href]:visible").first();
        await any.waitFor({ timeout: 15000, state: "visible" });
      };

      const currentUrl = driver.getCurrentUrl();
      if (!isGoogleUrl(currentUrl)) {
        await driver.goto("https://www.google.com", config.navigationTimeoutMs);
      }

      const input = page
        .locator("textarea[name='q'], textarea[aria-label='Search']")
        .first();

      await input.waitFor({ timeout: 15000, state: "visible" });
      await input.fill(step.query);
      await driver.press("Enter");

      try {
        await waitForResults();
      } catch {
        const queryUrl = `https://www.google.com/search?q=${encodeURIComponent(step.query)}`;
        await driver.goto(queryUrl, config.navigationTimeoutMs);

        try {
          await waitForResults();
        } catch {
          if (!page.url().includes("/search")) {
            throw new Error("Google search results were not detected");
          }
        }
      }

      return `Search results loaded for '${step.query}'`;
    }

    case "CLICK_FIRST_RESULT": {
      const page = driver.getPage();
      const previousUrl = page.url();
      const pagesBefore = page.context().pages().length;

      await page
        .locator("a h3:visible, div#search a[href]:visible")
        .first()
        .waitFor({ timeout: step.timeoutMs ?? 15000, state: "visible" });

      let clickedHref: string | null = null;

      try {
        const link = page.locator("a h3:visible").first().locator("xpath=ancestor::a[1]");
        clickedHref = await link.getAttribute("href");
        await link.click({ timeout: 15000 });
      } catch {
        const link = page.locator("div#search a[href]:visible").first();
        clickedHref = await link.getAttribute("href");
        await link.click({ timeout: 15000 });
      }

      try {
        await page.waitForURL((url) => url.toString() !== previousUrl, {
          timeout: config.navigationTimeoutMs,
        });
        return "Clicked first result";
      } catch {
        const pagesAfter = page.context().pages().length;
        if (pagesAfter > pagesBefore) {
          return "Clicked first result";
        }

        if (page.url() !== previousUrl) {
          return "Clicked first result";
        }

        if (clickedHref) {
          try {
            const resolved = new URL(clickedHref, previousUrl).toString();
            await page.goto(resolved, {
              timeout: config.navigationTimeoutMs,
              waitUntil: "domcontentloaded",
            });
            return "Clicked first result";
          } catch {
            // continue
          }
        }

        const external = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
          for (const a of anchors) {
            const href = a.getAttribute("href");
            if (!href) continue;
            try {
              const u = new URL(href, window.location.href);
              if (!/^https?:$/.test(u.protocol)) continue;
              if (u.hostname.toLowerCase().includes("google.")) continue;
              return u.toString();
            } catch {
              continue;
            }
          }
          return null;
        });

        if (!external) {
          throw new Error("No clickable result link found");
        }

        await page.goto(external, {
          timeout: config.navigationTimeoutMs,
          waitUntil: "domcontentloaded",
        });

        return "Clicked first result";
      }
    }

    case "WAIT_FOR_SELECTOR": {
      const page = driver.getPage();
      const state = step.state ?? "visible";
      await page.locator(step.selector).first().waitFor({
        timeout: step.timeoutMs ?? 15000,
        state,
      });
      return `Selector ready: ${step.selector}`;
    }

    case "CLICK": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? 15000;

      if (step.elementId !== undefined) {
        const selector = `[data-agent-id="${step.elementId}"]`;
        const loc = page.locator(selector).first();
        await clickWithOverlayFallback(loc, timeout, emitter);
        return `Clicked elementId: ${step.elementId}`;
      }

      if (step.selector) {
        const loc = page.locator(step.selector).first();
        await clickWithOverlayFallback(loc, timeout, emitter);
        return `Clicked selector: ${step.selector}`;
      }

      if (!step.text) {
        throw new Error("CLICK requires selector or text");
      }

      const mode = step.mode ?? "strict";
      const text = step.text;

      if (mode === "strict") {
        const candidate = page.getByRole("link", { name: text }).first();
        await clickWithOverlayFallback(candidate, timeout, emitter);
        return `Clicked text (strict): ${text}`;
      }

      const escapedForHasText = text.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");

      const attempts = [
        page.getByText(text, { exact: false }).first(),
        page.locator(`a:has-text("${escapedForHasText}")`).first(),
        page.locator(`text=${text}`).first(),
      ];

      let lastError: unknown;
      for (const candidate of attempts) {
        try {
          await clickWithOverlayFallback(candidate, Math.min(5000, timeout), emitter);
          return `Clicked text: ${text}`;
        } catch (error: unknown) {
          lastError = error;
        }
      }

      const fallbackHref = await page.evaluate((queryText: string) => {
        const tokens = queryText
          .toLowerCase()
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => token.length >= 4);

        if (tokens.length === 0) {
          return null;
        }

        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
        for (const anchor of anchors) {
          const textContent = (anchor.textContent ?? "").toLowerCase().trim();
          if (!textContent) {
            continue;
          }

          if (tokens.some((token) => textContent.includes(token))) {
            return anchor.getAttribute("href");
          }
        }

        return null;
      }, text);

      if (fallbackHref) {
        const resolved = new URL(fallbackHref, page.url()).toString();
        await page.goto(resolved, {
          timeout,
          waitUntil: "domcontentloaded",
        });
        return `Clicked text (fuzzy): ${text}`;
      }

      if (lastError instanceof Error) {
        throw lastError;
      }

      throw new Error(`Text not clickable: ${text}`);
    }

    case "PRESS": {
      const page = driver.getPage();
      await page.keyboard.press(step.key);
      return `Pressed '${step.key}'`;
    }

    case "SCROLL": {
      const page = driver.getPage();
      await page.evaluate((y) => window.scrollBy(0, y), step.deltaY);
      return `Scrolled ${step.deltaY}`;
    }

    case "WAIT_NAVIGATION": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? 15000;

      const beforeUrl = page.url();
      try {
        await page.waitForNavigation({
          timeout,
          waitUntil: "domcontentloaded",
        });
      } catch {
        // Ignore: navigation may not happen for SPA/in-page interactions.
      }

      try {
        await page.waitForLoadState("domcontentloaded", {
          timeout: Math.min(5000, timeout),
        });
      } catch {
        // Ignore: page may already be settled.
      }

      const afterUrl = page.url();
      if (beforeUrl === afterUrl) {
        emitter.emit(createLogEvent("info", "WAIT_NAVIGATION skipped: URL unchanged"));
      }

      return "Navigation completed";
    }

    case "SET_EVENT_DATE": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? config.navigationTimeoutMs;
      await setCalendarFieldExact(page, "startDate", step.date, timeout, emitter);
      return `Set event date '${step.date}'`;
    }

    case "SET_EVENT_START": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? config.navigationTimeoutMs;
      await setCalendarFieldExact(page, "startTime", step.time, timeout, emitter);
      return `Set event start '${step.time}'`;
    }

    case "SET_EVENT_END": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? config.navigationTimeoutMs;
      await setCalendarFieldExact(page, "endTime", step.time, timeout, emitter);
      return `Set event end '${step.time}'`;
    }

    case "SAVE_EVENT": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? 15000;
      const saved = await saveCalendarEvent(page, timeout, emitter);
      if (!saved) {
        throw new Error("Save event action not found");
      }
      return "Saved event";
    }

    case "TYPE": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? 15000;
      let target: Locator | null = null;
      const titleSelectorHint = typeof step.selector === "string"
        && isTitleSelectorHint(step.selector);
      const resolvedSelector = titleSelectorHint && step.selector
        ? stripVisiblePseudo(step.selector)
        : step.selector;

      if (isCalendarUrl(page.url()) && step.selector?.trim() === ":focus") {
        const parsedDateTime = parseCalendarDateTimeInput(step.text);
        if (parsedDateTime) {
          emitter.emit(
            createLogEvent(
              "info",
              `Calendar datetime split: ${parsedDateTime.date} ${parsedDateTime.start}-${parsedDateTime.end}`,
            ),
          );
          await setCalendarFieldExact(page, "startDate", parsedDateTime.date, timeout, emitter);
          await setCalendarFieldExact(page, "startTime", parsedDateTime.start, timeout, emitter);
          await setCalendarFieldExact(page, "endTime", parsedDateTime.end, timeout, emitter);
          return `Set calendar datetime '${step.text}'`;
        }
      }

      if (step.selector && isGenericEditableSelector(step.selector)) {
        const focused = page.locator(":focus").first();
        try {
          const focusedEditable = await focused.evaluate((element) => {
            const html = element as HTMLElement;
            const role = (html.getAttribute("role") ?? "").toLowerCase();
            const tag = html.tagName.toLowerCase();
            if (html.isContentEditable || role === "textbox") {
              return true;
            }

            if (tag === "textarea") {
              const textarea = html as HTMLTextAreaElement;
              return !textarea.disabled && !textarea.readOnly;
            }

            if (tag === "input") {
              const input = html as HTMLInputElement;
              const type = (input.type || "text").toLowerCase();
              const textLike = type === "text"
                || type === "search"
                || type === "email"
                || type === "url"
                || type === "tel"
                || type === "password"
                || type === "number";
              return textLike && !input.disabled && !input.readOnly;
            }

            return false;
          });

          if (focusedEditable) {
            await focused.waitFor({ timeout: Math.min(3000, timeout), state: "visible" });
            target = focused;
          }
        } catch {
          // Fall through to visible editable locator.
        }
      }

      if (!target) {
        if (step.selector?.trim() === ":focus") {
          const focused = page.locator(":focus").first();
          const focusedIsUsable = await focused.evaluate((element) => {
            const html = element as HTMLElement;
            const tag = html.tagName.toLowerCase();
            const role = (html.getAttribute("role") ?? "").toLowerCase();

            if (html.isContentEditable || role === "textbox") {
              return true;
            }

            if (tag === "textarea") {
              const textarea = html as HTMLTextAreaElement;
              return !textarea.disabled && !textarea.readOnly;
            }

            if (tag === "input") {
              const input = html as HTMLInputElement;
              const type = (input.type || "text").toLowerCase();
              const textLike = type === "text"
                || type === "search"
                || type === "email"
                || type === "url"
                || type === "tel"
                || type === "password"
                || type === "number";
              return textLike && !input.disabled && !input.readOnly;
            }

            return false;
          }).catch(() => false);

          if (focusedIsUsable) {
            target = focused;
          } else {
            const datetimeFallback = page
              .locator(":is(input:not([disabled])[aria-label*='дата' i], input:not([disabled])[aria-label*='time' i], input:not([disabled])[placeholder*='дата' i], input:not([disabled])[placeholder*='time' i], [role='textbox'][aria-label*='дата' i], [role='textbox'][aria-label*='time' i]):visible")
              .first();
            try {
              await datetimeFallback.waitFor({ timeout: Math.min(3000, timeout), state: "visible" });
              target = datetimeFallback;
            } catch {
              target = page.locator(GENERIC_EDITABLE_SELECTOR).first();
            }
          }
        }
      }

      if (!target) {
        target = step.label
          ? page.getByLabel(step.label, { exact: false }).first()
          : step.placeholder
            ? page.getByPlaceholder(step.placeholder, { exact: false }).first()
            : resolvedSelector
              ? isGenericEditableSelector(resolvedSelector)
                ? page.locator(GENERIC_EDITABLE_SELECTOR).first()
                : page.locator(resolvedSelector).first()
              : null;
      }

      if (!target) {
        throw new Error("TYPE requires one of: label | placeholder | selector");
      }

      if (titleSelectorHint) {
        await target.waitFor({ timeout, state: "attached" });
      } else {
        await target.waitFor({ timeout, state: "visible" });
      }

      const typingTarget = titleSelectorHint
        ? target
        : await resolveEditableTarget(target);
      const useKeyboardTyping = await shouldUseKeyboardTyping(typingTarget);
      let targetMeta: {
        tag: string;
        role: string;
        type: string;
        contentEditable: string;
        ariaLabel: string;
        placeholder: string;
        name: string;
      } | null = null;
      try {
        targetMeta = await typingTarget.evaluate((element) => {
          const html = element as HTMLElement;
          return {
            tag: html.tagName.toLowerCase(),
            role: html.getAttribute("role") ?? "",
            type: html.getAttribute("type") ?? "",
            contentEditable: html.getAttribute("contenteditable") ?? "",
            ariaLabel: html.getAttribute("aria-label") ?? "",
            placeholder: html.getAttribute("placeholder") ?? "",
            name: html.getAttribute("name") ?? "",
          };
        });
        emitter.emit(
          createLogEvent(
            "info",
            `TYPE target resolved: tag=${targetMeta.tag} role=${targetMeta.role || "-"} type=${targetMeta.type || "-"} aria=${targetMeta.ariaLabel || "-"} placeholder=${targetMeta.placeholder || "-"} name=${targetMeta.name || "-"} contenteditable=${targetMeta.contentEditable || "-"} keyboard=${useKeyboardTyping}`,
          ),
        );
      } catch {
        // Non-fatal: continue typing.
      }
      const isTitleField = targetMeta
        ? isTitleFieldHint(targetMeta)
        : await typingTarget.evaluate((element) => {
          const html = element as HTMLElement;
          const ariaLabel = html.getAttribute("aria-label") ?? "";
          const placeholder = html.getAttribute("placeholder") ?? "";
          const name = html.getAttribute("name") ?? "";
          return /назв|title|subject|summary/.test(`${ariaLabel} ${placeholder} ${name}`.toLowerCase());
        }).catch(() => false);
      const clearBeforeType = step.clearFirst === true || isTitleField;
      const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
      const keyboardPreferred = useKeyboardTyping || isTitleField;

      const applyType = async (): Promise<void> => {
        if (isTitleField) {
          const titleDebug = await typingTarget.evaluate((element) => {
            const html = element as HTMLElement;
            const rect = html.getBoundingClientRect();
            const visible = rect.width > 0
              && rect.height > 0
              && window.getComputedStyle(html).display !== "none"
              && window.getComputedStyle(html).visibility !== "hidden";
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const top = document.elementFromPoint(centerX, centerY) as HTMLElement | null;
            const active = document.activeElement as HTMLElement | null;
            const topDesc = top
              ? `${top.tagName.toLowerCase()}|${top.getAttribute("role") ?? "-"}|${top.getAttribute("aria-label") ?? "-"}|${top.getAttribute("placeholder") ?? "-"}`
              : "none";
            const activeDesc = active
              ? `${active.tagName.toLowerCase()}|${active.getAttribute("role") ?? "-"}|${active.getAttribute("aria-label") ?? "-"}|${active.getAttribute("placeholder") ?? "-"}`
              : "none";

            return {
              visible,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              topDesc,
              activeDesc,
            };
          }).catch(() => null);
          if (titleDebug) {
            emitter.emit(
              createLogEvent(
                "info",
                `TITLE pre-input: visible=${titleDebug.visible} bbox=${titleDebug.x},${titleDebug.y},${titleDebug.w}x${titleDebug.h} top=${titleDebug.topDesc} active=${titleDebug.activeDesc}`,
              ),
            );
          }
        }

        if (isTitleField) {
          await typingTarget.scrollIntoViewIfNeeded().catch(() => undefined);
          try {
            await typingTarget.click({ timeout: Math.min(2500, timeout), trial: true });
            await typingTarget.click({ timeout: Math.min(2500, timeout), force: true });
          } catch {
            await typingTarget.evaluate((element) => {
              (element as HTMLElement).focus();
            }).catch(() => undefined);
            await page.keyboard.press("Tab").catch(() => undefined);
          }
        } else {
          try {
            await typingTarget.click({ timeout: Math.min(3000, timeout) });
          } catch {
            // Non-fatal: focus below may still work.
          }
        }

        try {
          await typingTarget.evaluate((element) => {
            (element as HTMLElement).focus();
          });
        } catch {
          // Continue with keyboard/fill path.
        }

        if (!(await isActiveOn(typingTarget))) {
          try {
            await typingTarget.click({ timeout: Math.min(3000, timeout) });
          } catch {
            // Non-fatal: keep going.
          }
          try {
            await typingTarget.evaluate((element) => {
              (element as HTMLElement).focus();
            });
          } catch {
            // Keep going.
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 75));

        if (keyboardPreferred) {
          if (clearBeforeType) {
            try {
              await page.keyboard.press(selectAllShortcut);
              await page.keyboard.press("Backspace");
            } catch {
              // Continue typing even if clearing fails.
            }
          }

          await page.keyboard.type(step.text, { delay: isTitleField ? 5 : 0 });
          return;
        }

        if (clearBeforeType) {
          await typingTarget.fill("", { timeout });
        }
        await typingTarget.fill(step.text, { timeout });
      };

      await applyType();
      let observedValueMatches = false;

      try {
        const observed = await typingTarget.evaluate((element) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return element.value ?? "";
          }

          const html = element as HTMLElement;
          return html.innerText || html.textContent || "";
        });
        const normalizedObserved = isTitleField
          ? normalizeForExactMatch(String(observed))
          : normalizeForLooseMatch(String(observed));
        const normalizedExpected = isTitleField
          ? normalizeForExactMatch(step.text)
          : normalizeForLooseMatch(step.text);
        observedValueMatches = isTitleField
          ? normalizedObserved === normalizedExpected
          : normalizedObserved.includes(normalizedExpected);
        emitter.emit(createLogEvent("info", `TYPE observed value after applyType: ${String(observed).slice(0, 120)}`));
      } catch {
        // Ignore debug read failures.
      }

      const verifyTyped = async (): Promise<boolean> => {
        if (!isTitleField && observedValueMatches) {
          return true;
        }

        if (useKeyboardTyping) {
          return waitForTypedText(typingTarget, step.text, {
            initialDelayMs: 200,
            attempts: 5,
            intervalMs: 150,
            exact: isTitleField,
          });
        }

        return hasTypedText(typingTarget, step.text, { exact: isTitleField });
      };

      const applyKeyboardFallback = async (): Promise<boolean> => {
        try {
          await typingTarget.click({ timeout: Math.min(3000, timeout) });
        } catch {
          // Continue with focus attempt.
        }
        try {
          await typingTarget.evaluate((element) => {
            (element as HTMLElement).focus();
          });
        } catch {
          // Continue with keyboard fallback.
        }
        await new Promise((resolve) => setTimeout(resolve, 75));

        try {
          await page.keyboard.press(selectAllShortcut);
          await page.keyboard.press("Backspace");
        } catch {
          // Continue even if select-all fails.
        }

        await page.keyboard.type(step.text);
        return verifyTyped();
      };

      const applyDomInsertionFallback = async (): Promise<boolean> => {

        try {
          await typingTarget.evaluate((element, text) => {
            const html = element as HTMLElement;
            html.focus();

            if (html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement) {
              html.value = text;
            } else if (html.isContentEditable || html.getAttribute("contenteditable") === "true") {
              try {
                const selection = window.getSelection();
                if (selection) {
                  selection.removeAllRanges();
                }

                const range = document.createRange();
                range.selectNodeContents(html);
                range.collapse(true);
                selection?.addRange(range);

                if (typeof document.queryCommandSupported === "function"
                  && document.queryCommandSupported("insertText")) {
                  const inserted = document.execCommand("insertText", false, text);
                  if (!inserted) {
                    html.textContent = text;
                  }
                } else {
                  html.textContent = text;
                }
              } catch {
                html.textContent = text;
              }
            }

            if (typeof InputEvent === "function") {
              html.dispatchEvent(new InputEvent("input", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: text,
              }));
            } else {
              html.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
            }

            html.dispatchEvent(new Event("change", { bubbles: true }));
          }, step.text);
        } catch {
          return false;
        }

        return verifyTyped();
      };

      if (!(await verifyTyped())) {
        if (isTitleField) {
          emitter.emit(createLogEvent("warn", "TYPE title mismatch, trying DOM insertion fallback"));
          if (await applyDomInsertionFallback()) {
            return `Typed '${step.text}'`;
          }

          emitter.emit(createLogEvent("warn", "TYPE title mismatch, trying keyboard fallback"));
          if (await applyKeyboardFallback()) {
            return `Typed '${step.text}'`;
          }
        } else {
          emitter.emit(createLogEvent("warn", "TYPE input not reflected, trying keyboard fallback"));
          if (await applyKeyboardFallback()) {
            return `Typed '${step.text}'`;
          }

          emitter.emit(createLogEvent("warn", "TYPE input not reflected, trying DOM insertion fallback"));
          if (await applyDomInsertionFallback()) {
            return `Typed '${step.text}'`;
          }
        }

        emitter.emit(createLogEvent("warn", "TYPE verification failed, retrying with refocus"));
        await applyType();
        if (!(await verifyTyped())) {
          if (isTitleField) {
            emitter.emit(createLogEvent("warn", "TYPE title retry mismatch, trying DOM insertion fallback"));
            if (await applyDomInsertionFallback()) {
              return `Typed '${step.text}'`;
            }

            emitter.emit(createLogEvent("warn", "TYPE title retry mismatch, trying keyboard fallback"));
            if (await applyKeyboardFallback()) {
              return `Typed '${step.text}'`;
            }
          } else {
            emitter.emit(createLogEvent("warn", "TYPE retry not reflected, trying keyboard fallback"));
            if (await applyKeyboardFallback()) {
              return `Typed '${step.text}'`;
            }

            emitter.emit(createLogEvent("warn", "TYPE retry not reflected, trying DOM insertion fallback"));
            if (await applyDomInsertionFallback()) {
              return `Typed '${step.text}'`;
            }
          }

          throw new Error("Typed text was not applied to the target field");
        }
      }

      return `Typed '${step.text}'`;
    }

    case "EXTRACT": {
      const page = driver.getPage();
      const timeout = step.timeoutMs ?? 15000;
      let value: string;

      if (step.kind === "url") {
        value = page.url();
      } else if (step.kind === "title") {
        value = await page.title();
      } else {
        if (!step.selector) {
          throw new Error("EXTRACT text requires selector");
        }

        const element = page.locator(step.selector).first();
        await element.waitFor({ timeout, state: "visible" });
        value = ((await element.textContent()) ?? "").trim();
      }

      emitter.emit({
        type: "RESULT",
        kind: step.kind,
        value,
      });

      return `EXTRACT ${step.kind}`;
    }

    case "SNAPSHOT": {
      emitter.emit(createLogEvent("info", "capturing DOM snapshot"));
      const page = driver.getPage();
      const snapshot = await captureDomSnapshot(page);
      emitter.emit({
        type: "RESULT",
        kind: "snapshot",
        snapshot,
      });
      emitter.emit(createLogEvent("info", `snapshot captured (${snapshot.elements.length} elements)`));
      return `SNAPSHOT ${snapshot.elements.length} elements`;
    }

    case "WAIT_FOR_TEXT": {
      await driver.waitForText(step.text, step.timeoutMs ?? 15000);
      return `Text appeared: '${step.text}'`;
    }
  }
}

function throwIfAborted(shouldAbort?: () => boolean): void {
  if (shouldAbort?.()) {
    throw new ExecutionAbortedError();
  }
}

export async function executeSteps(options: ExecuteStepsOptions): Promise<void> {
  const {
    driver,
    config,
    emitter,
    steps,
    shouldAbort,
    waitForApproval,
  } = options;

  for (const step of steps) {
    throwIfAborted(shouldAbort);

    if (requiresApproval(step, getCurrentUrlSafe(driver))) {
      const reason = `Safety policy requires approval: ${describeStep(step)}`;
      emitter.emit({
        type: "NEED_APPROVAL",
        reason,
        step: {
          ...step,
        },
      });

      emitter.emit({
        type: "STATE",
        status: "PAUSED",
        step: step.type,
        message: "Waiting for user approval",
      });

      const approved = waitForApproval ? await waitForApproval() : false;
      throwIfAborted(shouldAbort);

      if (!approved) {
        const message = "User denied approval";

        emitter.emit({
          type: "ERROR",
          code: "SAFETY_DENIED",
          message,
        });

        emitter.emit({
          type: "STATE",
          status: "ERROR",
          step: step.type,
          message,
        });

        throw new StepExecutionFailedError(message);
      }

      emitter.emit(createLogEvent("info", "User approved step"));
    }

    const stepDescription = describeStep(step);
    emitter.emit(toState(step, stepDescription));
    emitter.emit(createLogEvent("info", `Starting step: ${step.type}`));

    let lastError: unknown;
    let completed = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      throwIfAborted(shouldAbort);

      try {
        const stepDetail = await runStep(step, driver, config, emitter);
        emitter.emit(createLogEvent("info", `Step OK: ${step.type}`));
        if (stepDetail) {
          emitter.emit(createLogEvent("info", stepDetail));
        }
        completed = true;
        break;
      } catch (error: unknown) {
        if (error instanceof ExecutionAbortedError) {
          throw error;
        }

        throwIfAborted(shouldAbort);
        lastError = error;

        if (attempt === MAX_RETRIES) {
          break;
        }

        const retryNumber = attempt + 1;
        emitter.emit(
          createLogEvent(
            "warn",
            `Retry ${retryNumber}/${MAX_RETRIES} for step ${step.type}: ${toErrorMessage(error)}`,
          ),
        );

        const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!completed) {
      const errorMessage = toErrorMessage(lastError);
      emitter.emit({
        type: "ERROR",
        code: "STEP_FAILED",
        message: `${step.type}: ${errorMessage}`,
      });
      emitter.emit({
        type: "STATE",
        status: "ERROR",
        step: step.type,
        message: errorMessage,
      });

      throw new StepExecutionFailedError(`${step.type}: ${errorMessage}`);
    }
  }
}
