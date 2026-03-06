import type { AgentStatus, OutboundMessage, StateEvent } from "@agent/shared";
import type { Page } from "playwright";

import type { RuntimeConfig } from "../config.js";
import { ChromeDriver } from "../chrome/chromeDriver.js";
import { ScreenshotStreamer } from "../chrome/screenshotStreamer.js";
import { requiresApproval } from "../safety/safetyGate.js";
import { createLogEvent, formatConsoleLog, type LogLevel } from "../utils/logger.js";
import { parseCommand } from "./commandParser.js";
import { checkCalendarSurface } from "./checkCalendarSurface.js";
import { captureDomSnapshot, type DomSnapshot } from "./domSnapshot.js";
import { hasCreateIntent, scoreCreateButton } from "./elementScoring.js";
import {
  executeSteps,
  ExecutionAbortedError,
  StepExecutionFailedError,
} from "./executor.js";
import { planWithLLM } from "./planner.js";
import { recallSelector, rememberSelector } from "./selectorMemory.js";
import type { Step } from "./steps.js";

interface OutboundEmitter {
  emit(message: OutboundMessage): void;
}

interface CreateUiSignals {
  hasDialog: boolean;
  visibleEditableCount: number;
  visibleInteractiveCount: number;
  visibleTextboxCount: number;
  activeSignature: string;
}

interface CreateConfirmationResult {
  confirmed: boolean;
  titleSelector: string | null;
}

interface IntermediateActionSelection {
  text: string;
  score: number;
}

interface RecoverCreateFromTasksResult {
  snapshot: DomSnapshot;
  confirmed: boolean;
  titleSelector: string | null;
}

const CALENDAR_TITLE_SELECTOR = ":is([contenteditable='true'][aria-label*='назв' i], [contenteditable='true'][aria-label*='title' i], [role='textbox'][aria-label*='назв' i], [role='textbox'][aria-label*='title' i], input[aria-label*='назв' i], input[aria-label*='title' i], input[placeholder*='Добавьте название' i], input[placeholder*='Add title' i], textarea[aria-label*='назв' i], textarea[aria-label*='title' i]):visible";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function toCreateSelector(elementId: number): string {
  return `[data-agent-id="${elementId}"]`;
}

function normalizeFallbackText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length > 120 ? normalized.slice(0, 120) : normalized;
}

async function clickWithFallback(page: Page, elementId: number, text?: string): Promise<void> {
  const selector = toCreateSelector(elementId);

  try {
    await page.locator(selector).first().click({ timeout: 5000 });
    return;
  } catch (error) {
    const fallbackText = normalizeFallbackText(text);
    if (!fallbackText) {
      throw error;
    }

    await page.getByText(fallbackText, { exact: false }).first().click({ timeout: 5000 });
  }
}

function isGenericTypeSelector(selector: string | undefined): boolean {
  if (!selector) {
    return true;
  }

  const normalized = selector.toLowerCase().replace(/\s+/g, "");
  return normalized.includes("input")
    && normalized.includes("textarea")
    && normalized.includes("contenteditable");
}

function isCreateLikeText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  return /create|new|add|plus|созда|добав|\+/.test(text.toLowerCase());
}

function isDeferredWhileFillingEvent(step: Step): boolean {
  return step.type === "OPEN_URL" || step.type === "WAIT_NAVIGATION" || step.type === "SNAPSHOT";
}

function hasCalendarCommandIntent(command: string): boolean {
  return /calendar\.google\.com|google\s+calendar|google\s+календар/i.test(command);
}

function isCalendarGateError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return message.startsWith("CALENDAR_SURFACE_GATE:");
}

async function findEventTitleField(page: Page): Promise<string | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const selector = await page.evaluate(() => {
      document
        .querySelectorAll("[data-agent-title-field='1']")
        .forEach((element) => element.removeAttribute("data-agent-title-field"));

      const prioritySelectors = [
        "[contenteditable='true'][aria-label*='назв' i]",
        "[contenteditable='true'][aria-label*='title' i]",
        "[contenteditable='true'][placeholder*='назв' i]",
        "[contenteditable='true'][placeholder*='title' i]",
        "[role='textbox'][aria-label*='назв' i]",
        "[role='textbox'][aria-label*='title' i]",
        "[role='textbox'][placeholder*='назв' i]",
        "[role='textbox'][placeholder*='title' i]",
        "div[contenteditable='true']",
        "[role='textbox']",
        "input[aria-label*='назв' i],input[aria-label*='title' i],input[placeholder*='назв' i],input[placeholder*='title' i],textarea[aria-label*='назв' i],textarea[aria-label*='title' i],textarea[placeholder*='назв' i],textarea[placeholder*='title' i]",
      ];

      const overlaySelector = "[role='dialog'], [aria-modal='true'], [role='menu'], [role='listbox'], .modal, .popover, .dropdown";

      for (const selector of prioritySelectors) {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
        let firstVisible: HTMLElement | null = null;
        let firstOverlay: HTMLElement | null = null;

        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") {
            continue;
          }

          const aria = (node.getAttribute("aria-label") ?? "").toLowerCase();
          const placeholder = (node.getAttribute("placeholder") ?? "").toLowerCase();
          const name = (node.getAttribute("name") ?? "").toLowerCase();
          const role = (node.getAttribute("role") ?? "").toLowerCase();
          const haystack = `${aria} ${placeholder} ${name}`.trim();
          if (/search|поиск|find/.test(haystack) || name === "q") {
            continue;
          }
          if (role === "combobox") {
            continue;
          }

          if (!firstVisible) {
            firstVisible = node;
          }
          if (!firstOverlay && node.closest(overlaySelector)) {
            firstOverlay = node;
          }
        }

        const match = firstOverlay ?? firstVisible;
        if (match) {
          match.setAttribute("data-agent-title-field", "1");
          return "[data-agent-title-field='1']";
        }
      }

      const richNodes = Array.from(
        document.querySelectorAll<HTMLElement>("[contenteditable='true'], [role='textbox']"),
      );
      let genericRich: HTMLElement | null = null;
      let genericRichOverlay: HTMLElement | null = null;
      for (const node of richNodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") {
          continue;
        }

        const aria = (node.getAttribute("aria-label") ?? "").toLowerCase();
        const placeholder = (node.getAttribute("placeholder") ?? "").toLowerCase();
        const name = (node.getAttribute("name") ?? "").toLowerCase();
        const role = (node.getAttribute("role") ?? "").toLowerCase();
        const haystack = `${aria} ${placeholder} ${name}`.trim();
        if (/search|поиск|find/.test(haystack) || name === "q") {
          continue;
        }
        if (role === "combobox") {
          continue;
        }

        if (!genericRich) {
          genericRich = node;
        }
        if (!genericRichOverlay && node.closest(overlaySelector)) {
          genericRichOverlay = node;
        }
      }
      const richMatch = genericRichOverlay ?? genericRich;
      if (richMatch) {
        richMatch.setAttribute("data-agent-title-field", "1");
        return "[data-agent-title-field='1']";
      }

      const inputNodes = Array.from(document.querySelectorAll<HTMLElement>("input, textarea"));
      let fallbackInput: HTMLElement | null = null;
      let fallbackInputOverlay: HTMLElement | null = null;
      for (const node of inputNodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") {
          continue;
        }

        const aria = (node.getAttribute("aria-label") ?? "").toLowerCase();
        const placeholder = (node.getAttribute("placeholder") ?? "").toLowerCase();
        const name = (node.getAttribute("name") ?? "").toLowerCase();
        const role = (node.getAttribute("role") ?? "").toLowerCase();
        const haystack = `${aria} ${placeholder} ${name}`.trim();
        if (/search|поиск|find/.test(haystack) || name === "q") {
          continue;
        }
        if (role === "combobox") {
          continue;
        }
        if (!/назв|title|subject|summary/.test(haystack)) {
          continue;
        }

        if (!fallbackInput) {
          fallbackInput = node;
        }
        if (!fallbackInputOverlay && node.closest(overlaySelector)) {
          fallbackInputOverlay = node;
        }
      }
      const inputMatch = fallbackInputOverlay ?? fallbackInput;
      if (inputMatch) {
        inputMatch.setAttribute("data-agent-title-field", "1");
        return "[data-agent-title-field='1']";
      }

      return null;
    });

    if (selector) {
      try {
        await page.locator(selector).first().waitFor({ timeout: 500, state: "visible" });
        return selector;
      } catch {
        // Keep polling briefly for stable visibility.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

export class AgentController {
  private readonly driver = new ChromeDriver();
  private streamer: ScreenshotStreamer | undefined;
  private status: AgentStatus = "IDLE";
  private runPromise: Promise<void> | undefined;
  private stopRequested = false;
  private approvalResolver: ((value: boolean) => void) | null = null;
  private lastSnapshot: DomSnapshot | null = null;

  constructor(
    private readonly emitter: OutboundEmitter,
    private readonly config: RuntimeConfig,
  ) {}

  run(command: string): void {
    if (this.runPromise) {
      this.log("warn", "RUN ignored: previous run is still active");
      return;
    }

    this.runPromise = this.execute(command)
      .catch((error: unknown) => {
        if (this.stopRequested) {
          this.log("info", "Run interrupted");
          return;
        }

        if (error instanceof StepExecutionFailedError || error instanceof ExecutionAbortedError) {
          return;
        }

        const message = toErrorMessage(error);
        this.emit({
          type: "ERROR",
          code: "RUN_FAILED",
          message,
        });
        this.setState("ERROR", "Execution failed", message);
      })
      .finally(() => {
        this.runPromise = undefined;
      });
  }

  pause(): void {
    if (this.status !== "RUNNING") {
      return;
    }

    this.setState("PAUSED", "Paused", "Execution paused by user");
    this.log("info", "Execution paused");
  }

  resume(): void {
    if (this.status !== "PAUSED" && this.status !== "NEEDS_USER") {
      return;
    }

    this.setState("RUNNING", "Resumed", "Execution resumed");
    this.log("info", "Execution resumed");
  }

  async stop(reason = "Stopped by user"): Promise<void> {
    this.stopRequested = true;
    this.resolvePendingApproval(false);
    await this.cleanupRuntime();
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined);
    }
    this.setState("IDLE", undefined, "Ready");
    this.log("info", reason);
  }

  approve(): void {
    if (!this.approvalResolver) {
      this.log("warn", "APPROVE ignored: no pending approval");
      return;
    }

    this.resolvePendingApproval(true);
  }

  deny(): void {
    if (!this.approvalResolver) {
      this.log("warn", "DENY ignored: no pending approval");
      return;
    }

    this.resolvePendingApproval(false);
  }

  async dispose(): Promise<void> {
    this.resolvePendingApproval(false);
    await this.cleanupRuntime();
  }

  private async focusTitleField(page: Page, selector: string): Promise<void> {
    try {
      await page.locator(selector).first().click({ timeout: 2000 });
    } catch (error: unknown) {
      if (selector === "[data-agent-title-field='1']") {
        try {
          await page.locator(CALENDAR_TITLE_SELECTOR).first().click({ timeout: 2000 });
          return;
        } catch {
          // Keep original warning path.
        }
      }
      this.log("warn", `Failed to focus title field: ${toErrorMessage(error)}`);
    }
  }

  private async tryClickSaveAction(page: Page): Promise<boolean> {
    const labels = ["Сохранить", "Save", "Done", "Готово"];

    for (const label of labels) {
      const roleLocator = page.getByRole("button", { name: label, exact: false }).first();
      try {
        await roleLocator.click({ timeout: 1500 });
        this.log("info", `Clicked save action: ${label}`);
        return true;
      } catch {
        try {
          await roleLocator.click({ timeout: 700, force: true });
          this.log("info", `Clicked save action (force): ${label}`);
          return true;
        } catch {
          // Try next label.
        }
      }
    }

    for (const label of labels) {
      const textLocator = page.getByText(label, { exact: false }).first();
      try {
        await textLocator.click({ timeout: 1500 });
        this.log("info", `Clicked save text action: ${label}`);
        return true;
      } catch {
        try {
          await textLocator.click({ timeout: 700, force: true });
          this.log("info", `Clicked save text action (force): ${label}`);
          return true;
        } catch {
          // Try next label.
        }
      }
    }

    return false;
  }

  private async verifySavedEventByTitle(page: Page, title: string | null): Promise<void> {
    if (!title) {
      this.log("warn", "Post-save verification skipped: event title is unknown");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    const exact = page.getByText(title, { exact: true }).first();
    const exactVisible = await exact.isVisible().catch(() => false);
    if (exactVisible) {
      this.log("info", `Post-save verification: event '${title}' is visible`);
      try {
        await exact.click({ timeout: 1500 });
      } catch {
        // Non-fatal: visibility confirmation is enough.
      }
      return;
    }

    const fuzzy = page.getByText(title, { exact: false }).first();
    const fuzzyVisible = await fuzzy.isVisible().catch(() => false);
    if (fuzzyVisible) {
      this.log("warn", `Post-save verification: exact title not found, fuzzy match visible for '${title}'`);
      return;
    }

    this.log("warn", `Post-save verification: could not find event '${title}' on calendar grid`);
  }

  private async recoverCreateFlowFromTasksSurface(page: Page): Promise<RecoverCreateFromTasksResult> {
    this.log(
      "warn",
      "Detected tasks surface after create-click; returning to calendar week view",
    );

    await page.goto("https://calendar.google.com/calendar/u/0/r", {
      waitUntil: "domcontentloaded",
    });

    let snapshot = await this.captureAndEmitSnapshot(
      "snapshot refreshed after returning from tasks",
    );

    const retryCandidate = scoreCreateButton(snapshot.elements)[0];
    if (!retryCandidate) {
      this.log("warn", "No create candidates found after returning from tasks");
      return {
        snapshot,
        confirmed: false,
        titleSelector: null,
      };
    }

    this.log(
      "info",
      `Retrying create action after tasks redirect with '${retryCandidate.text}'`,
    );

    try {
      const confirmation = await this.confirmCreateAction(
        page,
        async () => {
          await clickWithFallback(page, retryCandidate.id, retryCandidate.text);
        },
        async () => {
          const fallbackText = normalizeFallbackText(retryCandidate.text);
          if (fallbackText) {
            await page.getByText(fallbackText, { exact: false }).first().click({ timeout: 5000 });
            return;
          }

          await page.locator(toCreateSelector(retryCandidate.id)).first().click({ timeout: 5000 });
        },
      );

      if (confirmation.confirmed) {
        rememberSelector(snapshot.url, "create", toCreateSelector(retryCandidate.id));
      }

      snapshot = await this.captureAndEmitSnapshot(
        "snapshot refreshed after retrying create click",
      );

      return {
        snapshot,
        confirmed: confirmation.confirmed,
        titleSelector: confirmation.titleSelector,
      };
    } catch (error: unknown) {
      this.log("warn", `Retry create after tasks redirect failed: ${toErrorMessage(error)}`);
      return {
        snapshot,
        confirmed: false,
        titleSelector: null,
      };
    }
  }

  private async markActiveEditableTarget(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      document
        .querySelectorAll("[data-agent-active-editable='1']")
        .forEach((element) => element.removeAttribute("data-agent-active-editable"));

      const active = document.activeElement as HTMLElement | null;
      if (!active) {
        return null;
      }

      const rect = active.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      const style = window.getComputedStyle(active);
      if (style.display === "none" || style.visibility === "hidden") {
        return null;
      }

      const tag = active.tagName.toLowerCase();
      const role = (active.getAttribute("role") ?? "").toLowerCase();
      const isEditable = active.isContentEditable
        || active.getAttribute("contenteditable") === "true"
        || role === "textbox";

      if (!isEditable) {
        return null;
      }

      const haystack = `${active.getAttribute("aria-label") ?? ""} ${active.getAttribute("placeholder") ?? ""} ${active.getAttribute("name") ?? ""}`.toLowerCase();
      if (/search|поиск|find/.test(haystack) || active.getAttribute("name") === "q") {
        return null;
      }

      active.setAttribute("data-agent-active-editable", "1");
      return "[data-agent-active-editable='1']";
    });
  }

  private async isRichEditableSelector(page: Page, selector: string): Promise<boolean> {
    try {
      return await page.locator(selector).first().evaluate((element) => {
        const html = element as HTMLElement;
        const role = (html.getAttribute("role") ?? "").toLowerCase();
        if (html.isContentEditable
          || html.getAttribute("contenteditable") === "true"
          || role === "textbox") {
          return true;
        }

        const tag = html.tagName.toLowerCase();
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

  private async collectCreateUiSignals(page: Page): Promise<CreateUiSignals> {
    return page.evaluate(() => {
      const visibleEditableCount = Array.from(
        document.querySelectorAll("input, textarea, [role='textbox'], [contenteditable='true']"),
      ).reduce((count, element) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return count;
        }

        const style = window.getComputedStyle(html);
        if (style.display === "none" || style.visibility === "hidden") {
          return count;
        }

        return count + 1;
      }, 0);

      const visibleTextboxCount = Array.from(
        document.querySelectorAll("input[type='text'], input:not([type]), textarea, [role='textbox'], [contenteditable='true']"),
      ).reduce((count, element) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return count;
        }

        const style = window.getComputedStyle(html);
        if (style.display === "none" || style.visibility === "hidden") {
          return count;
        }

        return count + 1;
      }, 0);

      const visibleInteractiveCount = Array.from(
        document.querySelectorAll(
          "button, a[href], input, textarea, select, [role='button'], [role='link'], [tabindex]",
        ),
      ).reduce((count, element) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return count;
        }

        const style = window.getComputedStyle(html);
        if (style.display === "none" || style.visibility === "hidden") {
          return count;
        }

        return count + 1;
      }, 0);

      const hasDialog = Array.from(
        document.querySelectorAll("[role='dialog'], [aria-modal='true'], .modal, .popover"),
      ).some((element) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const style = window.getComputedStyle(html);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }

        return true;
      });

      const activeElement = document.activeElement as HTMLElement | null;
      const activeSignature = activeElement
        ? [
          activeElement.tagName.toLowerCase(),
          activeElement.getAttribute("role") ?? "",
          activeElement.getAttribute("aria-label") ?? "",
          activeElement.getAttribute("name") ?? "",
          activeElement.getAttribute("placeholder") ?? "",
        ].join("|")
        : "none";

      return {
        hasDialog,
        visibleEditableCount,
        visibleInteractiveCount,
        visibleTextboxCount,
        activeSignature,
      };
    });
  }

  private async confirmCreateSignals(
    page: Page,
    before: CreateUiSignals,
  ): Promise<CreateConfirmationResult> {
    await new Promise((resolve) => setTimeout(resolve, 700));

    const titleSelector = await findEventTitleField(page);
    const after = await this.collectCreateUiSignals(page);
    const reasons: string[] = [];

    if (titleSelector) {
      reasons.push("title field visible");
    }

    if (after.visibleTextboxCount > before.visibleTextboxCount) {
      reasons.push("visible textbox appeared");
    }

    if (after.hasDialog && !before.hasDialog) {
      reasons.push("dialog/popup appeared");
    }

    if (after.activeSignature !== before.activeSignature) {
      reasons.push("active element changed");
    }

    if (after.visibleEditableCount > before.visibleEditableCount) {
      reasons.push("new editable element appeared");
    }

    if (after.visibleInteractiveCount > before.visibleInteractiveCount) {
      reasons.push("visible interactive elements increased");
    }

    const hasStrongSignal = Boolean(titleSelector) || (after.hasDialog && !before.hasDialog);
    if (!hasStrongSignal) {
      return {
        confirmed: false,
        titleSelector: null,
      };
    }

    if (reasons.length > 0) {
      this.log("info", `Create confirmed via: ${reasons.join(", ")}`);
      return {
        confirmed: true,
        titleSelector,
      };
    }

    return {
      confirmed: false,
      titleSelector: null,
    };
  }

  private async selectIntermediateCreateAction(page: Page): Promise<IntermediateActionSelection | null> {
    const candidate = await page.evaluate(() => {
      document
        .querySelectorAll("[data-agent-intermediate-action='1']")
        .forEach((element) => element.removeAttribute("data-agent-intermediate-action"));

      const menuRoots = Array.from(
        document.querySelectorAll(
          "[role='menu'],[role='listbox'],[role='dialog'],[aria-modal='true'],.menu,.dropdown,.popover,.modal,[data-menu],[data-popover]",
        ),
      ).filter((root) => {
        const html = root as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const style = window.getComputedStyle(html);
        return style.display !== "none" && style.visibility !== "hidden";
      });

      if (menuRoots.length === 0) {
        return null;
      }

      let bestElement: Element | null = null;
      let bestText = "";
      let bestScore = 0;

      for (const root of menuRoots) {
        const items = Array.from(
          root.querySelectorAll(
            "button, [role='menuitem'], [role='option'], [role='button'], [tabindex], a[href], li",
          ),
        );

        for (const item of items) {
          const html = item as HTMLElement;
          const rect = html.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          const style = window.getComputedStyle(html);
          if (style.display === "none" || style.visibility === "hidden") {
            continue;
          }

          const text = (
            html.innerText
            || html.textContent
            || html.getAttribute("aria-label")
            || ""
          ).replace(/\s+/g, " ").trim();
          if (!text) {
            continue;
          }

          const lower = text.toLowerCase();
          let score = 0;

          if (lower.includes("event") || lower.includes("мероприят")) {
            score += 12;
          }
          if (lower.includes("meeting") || lower.includes("appointment")) {
            score += 10;
          }
          if (lower.includes("задач") || lower.includes("task")) {
            score -= 4;
          }
          if (lower.includes("расписан") || lower.includes("schedule")) {
            score -= 2;
          }

          const role = (html.getAttribute("role") || "").toLowerCase();
          if (role === "menuitem" || role === "option") {
            score += 2;
          } else if (role === "button") {
            score += 1;
          }

          if (html.tagName.toLowerCase() === "button") {
            score += 1;
          }

          if (score > bestScore) {
            bestScore = score;
            bestText = text;
            bestElement = item;
          }
        }
      }

      if (!bestElement || bestScore <= 0) {
        return null;
      }

      (bestElement as HTMLElement).setAttribute("data-agent-intermediate-action", "1");
      return {
        text: bestText,
        score: bestScore,
      };
    });

    if (!candidate) {
      return null;
    }

    this.log("info", `Intermediate action selected: '${candidate.text}' (score=${candidate.score})`);

    const actionLocator = page.locator("[data-agent-intermediate-action='1']").first();
    try {
      await actionLocator.click({ timeout: 3000 });
    } catch {
      await actionLocator.evaluate((element) => {
        (element as { click: () => void }).click();
      });
    } finally {
      await page.evaluate(() => {
        document
          .querySelectorAll("[data-agent-intermediate-action='1']")
          .forEach((element) => element.removeAttribute("data-agent-intermediate-action"));
      });
    }

    return candidate;
  }

  private async confirmCreateAction(
    page: Page,
    primaryClick: () => Promise<void>,
    retryClick: () => Promise<void>,
  ): Promise<CreateConfirmationResult> {
    const resolveConfirmation = async (baseline: CreateUiSignals): Promise<CreateConfirmationResult> => {
      let confirmation = await this.confirmCreateSignals(page, baseline);

      if (!confirmation.titleSelector) {
        const beforeMenu = await this.collectCreateUiSignals(page);
        const selected = await this.selectIntermediateCreateAction(page);
        if (selected) {
          const afterMenuConfirmation = await this.confirmCreateSignals(page, beforeMenu);
          confirmation = {
            confirmed: confirmation.confirmed || afterMenuConfirmation.confirmed,
            titleSelector: afterMenuConfirmation.titleSelector ?? confirmation.titleSelector,
          };
        }
      }

      if (confirmation.confirmed && confirmation.titleSelector) {
        await this.focusTitleField(page, confirmation.titleSelector);
      }

      return confirmation;
    };

    const before = await this.collectCreateUiSignals(page);
    await primaryClick();

    let confirmation = await resolveConfirmation(before);
    if (confirmation.confirmed) {
      return confirmation;
    }

    this.log("warn", "Create click not confirmed, retrying once");
    try {
      await retryClick();
    } catch (error: unknown) {
      this.log("warn", `Create retry click failed: ${toErrorMessage(error)}`);
    }

    confirmation = await resolveConfirmation(before);
    if (confirmation.confirmed) {
      return confirmation;
    }

    this.log("warn", "Create action not confirmed after retry");
    return {
      confirmed: false,
      titleSelector: null,
    };
  }

  private async execute(command: string): Promise<void> {
    this.stopRequested = false;
    this.lastSnapshot = null;

    this.log("info", `RUN command: ${command}`);
    this.setState("RUNNING", "Launch browser", "Starting Chrome via Playwright");
    await this.driver.launchBrowser({ headless: false });
    await this.driver.newPage();

    this.startStreaming();

    if (this.stopRequested) {
      return;
    }

    this.setState("RUNNING", "Plan steps", "Capturing DOM snapshot and planning");
    await this.executeWithRetry(command);

    if (this.stopRequested) {
      return;
    }

    this.setState("DONE", "Completed", "Command completed successfully");
    this.log("info", "Run completed");
  }

  private startStreaming(): void {
    if (this.streamer) {
      return;
    }

    this.streamer = new ScreenshotStreamer(
      this.driver,
      (frame) => {
        this.emit(frame);
      },
      {
        fps: this.config.frameFps,
        quality: this.config.screenshotQuality,
      },
    );

    this.streamer.start();
    this.log("info", `Frame streamer started (${this.config.frameFps} fps)`);
  }

  private async cleanupRuntime(): Promise<void> {
    if (this.streamer) {
      this.streamer.stop();
      this.streamer = undefined;
    }

    await this.driver.close();
  }

  private async executeWithRetry(command: string): Promise<void> {
    let attempt = 0;
    let lastError: unknown;
    let previousError: string | undefined;
    const canUseSemanticCreate = hasCreateIntent(command);
    const shouldEnforceCalendarSurface = hasCalendarCommandIntent(command);

    while (attempt < 2) {
      try {
        let steps = await this.buildPlan(command, previousError);
        if (steps.length === 0) {
          throw new Error("No executable steps generated");
        }

        let snapshotLoops = 0;
        let semanticCreateUsed = false;
        let eventFormOpening = false;
        let createFormConfirmed = false;
        let runtimeTitleSelector: string | null = null;
        let titleTyped = false;
        let datetimeTyped = false;
        let eventSaved = false;
        let createdEventTitle: string | null = null;

        while (steps.length > 0) {
          if (this.stopRequested) {
            return;
          }

          const step = steps.shift();
          if (!step) {
            break;
          }

          await executeSteps({
            driver: this.driver,
            config: this.config,
            emitter: {
              emit: (message: OutboundMessage) => {
                this.emit(message);
              },
            },
            steps: [step],
            shouldAbort: () => this.stopRequested,
            waitForApproval: () => this.waitForApproval(),
          });

          if (shouldEnforceCalendarSurface) {
            await this.enforceCalendarSurfaceGate(step);
          }

          if (createFormConfirmed) {
            if (step.type === "TYPE") {
              if (!titleTyped) {
                titleTyped = true;
                createdEventTitle = step.text;
              } else if (!datetimeTyped) {
                datetimeTyped = true;
              }
            }

            if (step.type === "SET_EVENT_START" || step.type === "SET_EVENT_END") {
              datetimeTyped = true;
            }

            if (step.type === "PRESS" && step.key.toLowerCase() === "enter") {
              eventSaved = true;
              const page = this.driver.getPage();
              const titleStillVisible = await findEventTitleField(page);
              if (titleStillVisible) {
                this.log("info", "Event form still open after Enter, trying Save action");
                const clickedSave = await this.tryClickSaveAction(page);
                if (clickedSave) {
                  await new Promise((resolve) => setTimeout(resolve, 300));
                  const stillVisibleAfterSave = await findEventTitleField(page);
                  if (stillVisibleAfterSave) {
                    this.log("warn", "Save action clicked but form still appears open");
                  } else {
                    eventSaved = true;
                  }
                }
              }
              await this.verifySavedEventByTitle(page, createdEventTitle);
            }

            if (step.type === "CLICK") {
              const clickText = (step.text ?? "").toLowerCase();
              if (/save|done|готов|сохран/.test(clickText)) {
                eventSaved = true;
              }
            }

            if (step.type === "SAVE_EVENT") {
              eventSaved = true;
              const page = this.driver.getPage();
              await this.verifySavedEventByTitle(page, createdEventTitle);
            }
          }

          if (step.type === "SNAPSHOT") {
            snapshotLoops += 1;
            if (snapshotLoops > 6) {
              throw new Error("SNAPSHOT reasoning limit exceeded");
            }

            const snapshot = this.lastSnapshot;
            if (!snapshot) {
              this.log("warn", "Snapshot result is missing; continuing current plan");
              continue;
            }

            if (steps.length === 0) {
              this.log("info", "No remaining queued steps after SNAPSHOT; skipping replanning");
              continue;
            }

            let planningSnapshot = snapshot;

            if (canUseSemanticCreate && !semanticCreateUsed) {
              const page = this.driver.getPage();
              const createCandidates = scoreCreateButton(snapshot.elements);
              const fallbackCandidate = createCandidates[0];
              const rememberedSelector = recallSelector(snapshot.url, "create");
              if (rememberedSelector) {
                this.log("info", `create-selector-memory hit: ${rememberedSelector}`);
                try {
                  const confirmation = await this.confirmCreateAction(
                    page,
                    async () => {
                      await page.locator(rememberedSelector).first().click({ timeout: 5000 });
                    },
                    async () => {
                      if (fallbackCandidate) {
                        await clickWithFallback(page, fallbackCandidate.id, fallbackCandidate.text);
                        return;
                      }

                      await page.getByText("Create", { exact: false }).first().click({ timeout: 3000 });
                    },
                  );
                  semanticCreateUsed = confirmation.confirmed;
                  eventFormOpening = confirmation.confirmed;
                  createFormConfirmed = confirmation.confirmed;
                  runtimeTitleSelector = confirmation.confirmed ? confirmation.titleSelector : null;

                  planningSnapshot = await this.captureAndEmitSnapshot(
                    "snapshot refreshed after selector-memory click",
                  );

                  const urlAfterRememberedClick = this.tryGetCurrentUrl();
                  if (urlAfterRememberedClick && /\/r\/tasks/.test(urlAfterRememberedClick)) {
                    const recovery = await this.recoverCreateFlowFromTasksSurface(page);
                    planningSnapshot = recovery.snapshot;

                    if (recovery.confirmed) {
                      createFormConfirmed = true;
                      runtimeTitleSelector = recovery.titleSelector;
                      eventFormOpening = true;
                    } else {
                      createFormConfirmed = false;
                      runtimeTitleSelector = null;
                      semanticCreateUsed = false;
                      eventFormOpening = false;
                    }
                  }
                } catch (error: unknown) {
                  this.log("warn", `Selector-memory click failed: ${toErrorMessage(error)}`);
                }
              }

              if (!semanticCreateUsed) {
                if (fallbackCandidate) {
                  this.log(
                    "info",
                    `auto-create-button text='${fallbackCandidate.text}' score=${fallbackCandidate.score}`,
                  );

                  try {
                    const confirmation = await this.confirmCreateAction(
                      page,
                      async () => {
                        await clickWithFallback(page, fallbackCandidate.id, fallbackCandidate.text);
                      },
                      async () => {
                        const fallbackText = normalizeFallbackText(fallbackCandidate.text);
                        if (fallbackText) {
                          await page.getByText(fallbackText, { exact: false }).first().click({ timeout: 5000 });
                          return;
                        }

                        await page.locator(toCreateSelector(fallbackCandidate.id)).first().click({ timeout: 5000 });
                      },
                    );
                    semanticCreateUsed = confirmation.confirmed;
                    eventFormOpening = confirmation.confirmed;
                    createFormConfirmed = confirmation.confirmed;
                    runtimeTitleSelector = confirmation.confirmed ? confirmation.titleSelector : null;
                    if (confirmation.confirmed) {
                      rememberSelector(snapshot.url, "create", toCreateSelector(fallbackCandidate.id));
                    }

                    planningSnapshot = await this.captureAndEmitSnapshot(
                      "snapshot refreshed after semantic click",
                    );

                    const urlAfterCreateClick = this.tryGetCurrentUrl();
                    if (urlAfterCreateClick && /\/r\/tasks/.test(urlAfterCreateClick)) {
                      const recovery = await this.recoverCreateFlowFromTasksSurface(page);
                      planningSnapshot = recovery.snapshot;

                      if (recovery.confirmed) {
                        createFormConfirmed = true;
                        runtimeTitleSelector = recovery.titleSelector;
                        eventFormOpening = true;
                      } else {
                        createFormConfirmed = false;
                        runtimeTitleSelector = null;
                        semanticCreateUsed = false;
                        eventFormOpening = false;
                      }
                    }
                  } catch (error: unknown) {
                    this.log("warn", `Semantic create click failed: ${toErrorMessage(error)}`);
                  }
                }
              }
            }

            if (eventFormOpening) {
              this.log("info", "Event form opening — skipping navigation/snapshot replanning");
              const immediateSteps: Step[] = [];
              const deferredSteps: Step[] = [];

              for (const queuedStep of steps) {
                if (queuedStep.type === "CLICK" && isCreateLikeText(queuedStep.text)) {
                  this.log("info", "Removed duplicate create-click step");
                  continue;
                }

                if (createFormConfirmed && queuedStep.type === "CLICK" && !titleTyped) {
                  this.log("info", "Removed pre-title CLICK after confirmed create");
                  continue;
                }

                if (createFormConfirmed && isDeferredWhileFillingEvent(queuedStep)) {
                  deferredSteps.push(queuedStep);
                  continue;
                }

                immediateSteps.push(queuedStep);
              }

              steps = [...immediateSteps, ...deferredSteps];

              if (createFormConfirmed && deferredSteps.length > 0) {
                this.log("info", `Deferred ${deferredSteps.length} navigation/snapshot step(s) until form fill`);
              }

              if (createFormConfirmed) {
                if (semanticCreateUsed) {
                  const withoutOpenUrl = steps.filter((queuedStep) => queuedStep.type !== "OPEN_URL");
                  if (withoutOpenUrl.length !== steps.length) {
                    this.log("info", "Removed OPEN_URL steps after semantic create");
                  }
                  steps = withoutOpenUrl;
                }
              } else {
                this.log("warn", "Create was not confirmed; continuing with safe non-navigation steps");
                steps = steps.filter((queuedStep) => !isDeferredWhileFillingEvent(queuedStep));
                steps = steps.filter((queuedStep) => queuedStep.type !== "OPEN_URL");
              }

              if (createFormConfirmed) {
                const page = this.driver.getPage();
                let pinnedSelector = runtimeTitleSelector;
                if (pinnedSelector === "[data-agent-title-field='1']") {
                  pinnedSelector = CALENDAR_TITLE_SELECTOR;
                  runtimeTitleSelector = CALENDAR_TITLE_SELECTOR;
                }
                if (pinnedSelector) {
                  const isRich = await this.isRichEditableSelector(page, pinnedSelector);
                  if (!isRich) {
                    this.log("warn", "Resolved title selector is not rich editable; trying live title resolve");
                    const liveTitleSelector = await findEventTitleField(page);
                    if (liveTitleSelector) {
                      pinnedSelector = liveTitleSelector;
                      runtimeTitleSelector = liveTitleSelector;
                      await this.focusTitleField(page, liveTitleSelector);
                    } else {
                      pinnedSelector = null;
                    }
                  } else {
                    await this.focusTitleField(page, pinnedSelector);
                  }
                }

                if (!pinnedSelector) {
                  const liveTitleSelector = await findEventTitleField(page);
                  if (liveTitleSelector) {
                    pinnedSelector = liveTitleSelector;
                    runtimeTitleSelector = liveTitleSelector;
                    await this.focusTitleField(page, liveTitleSelector);
                  }
                }

                if (!pinnedSelector) {
                  const activeSelector = await this.markActiveEditableTarget(page);
                  if (activeSelector) {
                    pinnedSelector = activeSelector;
                    runtimeTitleSelector = activeSelector;
                    this.log("info", `Pinned first TYPE to active editable selector: ${activeSelector}`);
                  }
                }

                if (!pinnedSelector) {
                  pinnedSelector = ":is(input, textarea, [contenteditable='true'], [role='textbox']):visible";
                }

                const firstTypeIndex = steps.findIndex((queuedStep) => queuedStep.type === "TYPE");
                if (firstTypeIndex >= 0) {
                  const firstTypeStep = steps[firstTypeIndex];
                  if (firstTypeStep?.type === "TYPE") {
                    steps[firstTypeIndex] = {
                      ...firstTypeStep,
                      selector: pinnedSelector,
                      label: undefined,
                      placeholder: undefined,
                      clearFirst: true,
                    };
                    this.log("info", `Pinned first TYPE to title selector: ${pinnedSelector}`);
                  }

                  const secondTypeIndex = steps.findIndex(
                    (queuedStep, index) => index > firstTypeIndex && queuedStep.type === "TYPE",
                  );
                  if (secondTypeIndex >= 0) {
                    const secondTypeStep = steps[secondTypeIndex];
                    if (secondTypeStep?.type === "TYPE" && isGenericTypeSelector(secondTypeStep.selector)) {
                      steps[secondTypeIndex] = {
                        ...secondTypeStep,
                        selector: ":focus",
                        label: undefined,
                        placeholder: undefined,
                      };
                      this.log("info", "Pinned second TYPE to focused field");
                    }
                  }
                }
              }

              eventFormOpening = false;
              continue;
            }

            const eventFormFlowCompleted = titleTyped && datetimeTyped && eventSaved;
            const remainingSteps = semanticCreateUsed
              ? eventFormFlowCompleted
                ? steps.filter((pendingStep) => pendingStep.type !== "OPEN_URL")
                : steps.filter((pendingStep) => !isDeferredWhileFillingEvent(pendingStep) && pendingStep.type !== "OPEN_URL")
              : [...steps];
            const replannedRaw = await this.planFromSnapshot(command, planningSnapshot, {
              previousError,
              allowParserFallback: false,
            });
            const replanned = semanticCreateUsed
              ? eventFormFlowCompleted
                ? replannedRaw.filter((plannedStep) => plannedStep.type !== "OPEN_URL")
                : replannedRaw.filter(
                  (plannedStep) =>
                    !isDeferredWhileFillingEvent(plannedStep) && plannedStep.type !== "OPEN_URL",
                )
              : replannedRaw;

            if (semanticCreateUsed && replannedRaw.length !== replanned.length) {
              this.log("info", "Removed OPEN_URL steps after semantic create");
            }

            if (replanned.length > 0) {
              this.log("info", `Replanned after snapshot: ${replanned.length} steps`);
              steps = replanned;
            } else {
              this.log("warn", "Snapshot replanning returned no steps; continuing current plan");
              steps = remainingSteps;
            }
          }
        }

        return;
      } catch (error: unknown) {
        lastError = error;
        previousError = toErrorMessage(error);

        if (isCalendarGateError(error)) {
          this.log("warn", "Plan attempt stopped by calendar surface gate");
          break;
        }

        attempt += 1;

        this.log("warn", `Plan attempt ${attempt} failed`);

        if (attempt >= 2 || this.stopRequested) {
          break;
        }
      }
    }

    throw lastError ?? new Error("Execution failed");
  }

  private async enforceCalendarSurfaceGate(step: Step): Promise<void> {
    if (step.type !== "OPEN_URL" && step.type !== "WAIT_NAVIGATION") {
      return;
    }

    const page = this.driver.getPage();
    const currentUrl = page.url();
    const relevant = /calendar\.google\.com|workspace\.google\.com|accounts\.google\.com|support\.google\.com/i
      .test(currentUrl);
    if (!relevant) {
      return;
    }

    let check = await checkCalendarSurface(page);
    if (!check.ok && check.code === "NOT_CALENDAR_SURFACE") {
      this.log("warn", `Calendar surface check soft-retry: ${check.reason} url=${check.url}`);
      try {
        await page.goto("https://calendar.google.com/calendar/u/0/r", {
          waitUntil: "domcontentloaded",
          timeout: Math.min(this.config.navigationTimeoutMs, 10_000),
        });
        await page.waitForTimeout(500);
      } catch {
        // Continue to terminal check.
      }
      check = await checkCalendarSurface(page);
    }

    if (check.ok) {
      return;
    }

    const message = `CALENDAR_SURFACE_GATE:${check.code}:${check.reason} url=${check.url}`;
    this.log("error", `Calendar surface gate failed (${check.code}): ${check.reason} url=${check.url}`);
    this.emit({
      type: "ERROR",
      code: check.code,
      message: check.reason,
    });
    this.setState("ERROR", step.type, check.reason);
    throw new StepExecutionFailedError(message);
  }

  private async buildPlan(command: string, previousError?: string): Promise<Step[]> {
    await this.preloadSnapshotPage(command);

    const page = this.driver.getPage();
    const snapshot = await captureDomSnapshot(page);
    return this.planFromSnapshot(command, snapshot, {
      previousError,
      allowParserFallback: true,
    });
  }

  private async planFromSnapshot(
    command: string,
    snapshot: Awaited<ReturnType<typeof captureDomSnapshot>>,
    options?: {
      previousError?: string;
      allowParserFallback?: boolean;
    },
  ): Promise<Step[]> {
    const previousError = options?.previousError;
    const allowParserFallback = options?.allowParserFallback ?? true;

    if (!allowParserFallback && !process.env.OPENAI_API_KEY) {
      this.log("warn", "OPENAI_API_KEY missing; skip snapshot replanning");
      return [];
    }

    try {
      const planned = await planWithLLM(command, snapshot, { previousError });
      const sanitized = this.sanitizeSteps(planned.steps);
      this.log("info", `Planner produced ${sanitized.length} steps`);
      if (sanitized.length > 0) {
        this.log("info", `Planner source: llm (${sanitized.length} steps)`);
        return sanitized;
      }
      this.log("warn", "LLM planner returned empty plan, using parser fallback");
    } catch (error: unknown) {
      this.log("warn", `LLM planner failed, using parser fallback: ${toErrorMessage(error)}`);
    }

    if (!allowParserFallback) {
      this.log("warn", "Parser fallback disabled for this replanning pass");
      return [];
    }

    const parsed = parseCommand(command);
    const sanitized = this.sanitizeSteps(parsed.steps);
    this.log("info", `Planner produced ${sanitized.length} steps`);
    this.log("info", `Planner source: parser (${sanitized.length} steps)`);
    return sanitized;
  }

  private async preloadSnapshotPage(command: string): Promise<void> {
    let parsed;
    try {
      parsed = parseCommand(command);
    } catch {
      return;
    }

    const firstStep = parsed.steps[0];
    if (!firstStep || firstStep.type !== "OPEN_URL") {
      return;
    }

    if (requiresApproval(firstStep, this.tryGetCurrentUrl())) {
      this.log("info", `Skipping preloading URL due to safety policy: ${firstStep.url}`);
      return;
    }

    try {
      await this.driver.goto(firstStep.url, Math.min(this.config.navigationTimeoutMs, 10_000));
      this.log("info", `Preloaded URL for snapshot: ${firstStep.url}`);
    } catch (error: unknown) {
      this.log("warn", `Failed to preload URL for snapshot: ${toErrorMessage(error)}`);
    }
  }

  private sanitizeSteps(steps: Step[]): Step[] {
    return steps.filter((step) => {
      if (step.type === "OPEN_URL") {
        return /^https?:\/\//i.test(step.url);
      }

      if (step.type === "CLICK") {
        return step.elementId !== undefined || Boolean(step.selector || step.text);
      }

      if (step.type === "TYPE") {
        return Boolean(step.text && (step.selector || step.label || step.placeholder));
      }

      if (step.type === "SNAPSHOT") {
        return true;
      }

      return true;
    });
  }

  private async captureAndEmitSnapshot(logMessage: string): Promise<DomSnapshot> {
    const refreshedSnapshot = await captureDomSnapshot(this.driver.getPage());
    this.lastSnapshot = refreshedSnapshot;
    this.emit({
      type: "RESULT",
      kind: "snapshot",
      snapshot: refreshedSnapshot,
    });
    this.log("info", `${logMessage} (${refreshedSnapshot.elements.length} elements)`);
    return refreshedSnapshot;
  }

  private tryGetCurrentUrl(): string | undefined {
    try {
      return this.driver.getCurrentUrl();
    } catch {
      return undefined;
    }
  }

  private waitForApproval(): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvalResolver = resolve;
    });
  }

  private resolvePendingApproval(value: boolean): void {
    if (!this.approvalResolver) {
      return;
    }

    const resolver = this.approvalResolver;
    this.approvalResolver = null;
    resolver(value);
  }

  private setState(status: AgentStatus, step?: string, message?: string): void {
    this.status = status;

    const stateEvent: StateEvent = {
      type: "STATE",
      status,
      step,
      message,
    };

    this.emit(stateEvent);
  }

  private log(level: LogLevel, message: string): void {
    this.emit(createLogEvent(level, message));
    console.log(formatConsoleLog(level, message));
  }

  private emit(message: OutboundMessage): void {
    if (message.type === "RESULT" && message.kind === "snapshot") {
      this.lastSnapshot = message.snapshot;
    }
    this.emitter.emit(message);
  }
}
