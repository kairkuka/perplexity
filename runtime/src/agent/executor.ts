import type { OutboundMessage, StateEvent } from "@agent/shared";
import type { Page } from "playwright";

import type { RuntimeConfig } from "../config.js";
import { createLogEvent } from "../utils/logger.js";
import type { Step } from "./steps.js";

const RETRY_DELAYS_MS = [500, 1500];
const MAX_RETRIES = 2;

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
    case "WAIT_FOR_TEXT":
      return `Wait for text '${step.text}'`;
  }
}

async function runStep(
  step: Step,
  driver: StepExecutorDriver,
  config: RuntimeConfig,
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
  } = options;

  for (const step of steps) {
    throwIfAborted(shouldAbort);

    const stepDescription = describeStep(step);
    emitter.emit(toState(step, stepDescription));
    emitter.emit(createLogEvent("info", `Starting step: ${step.type}`));

    let lastError: unknown;
    let completed = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      throwIfAborted(shouldAbort);

      try {
        const stepDetail = await runStep(step, driver, config);
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
