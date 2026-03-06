import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

export interface LaunchOptions {
  headless: boolean;
}

type BrowserMode = "local" | "persistent" | "cdp";

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }

  return fallback;
}

export class ChromeDriver {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private mode: BrowserMode | undefined;

  async launchBrowser(options: LaunchOptions = { headless: false }): Promise<void> {
    if (this.browser?.isConnected()) {
      return;
    }

    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.mode = undefined;

    if (await this.tryConnectExistingChrome()) {
      return;
    }

    if (await this.tryLaunchWithUserProfile(options)) {
      return;
    }

    await this.launchIsolatedBrowser(options);
  }

  private async tryConnectExistingChrome(): Promise<boolean> {
    const shouldConnectExisting = readBooleanEnv(process.env.CHROME_CONNECT_EXISTING, true);
    if (!shouldConnectExisting) {
      return false;
    }

    const cdpUrl = process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222";

    try {
      const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 2000 });
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        await browser.close();
        return false;
      }

      this.browser = browser;
      this.context = contexts[0];
      this.mode = "cdp";
      return true;
    } catch {
      return false;
    }
  }

  private async tryLaunchWithUserProfile(options: LaunchOptions): Promise<boolean> {
    const shouldUseProfile = readBooleanEnv(process.env.CHROME_USE_USER_PROFILE, true);
    if (!shouldUseProfile || process.platform !== "darwin") {
      return false;
    }

    const userDataDir = process.env.CHROME_USER_DATA_DIR
      ?? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    const profileDirectory = process.env.CHROME_PROFILE_DIRECTORY ?? "Default";

    try {
      this.context = await chromium.launchPersistentContext(userDataDir, {
        channel: "chrome",
        headless: options.headless,
        viewport: { width: 1366, height: 768 },
        args: [`--profile-directory=${profileDirectory}`],
      });
      this.browser = this.context.browser() ?? undefined;
      this.mode = "persistent";
      return true;
    } catch {
      return false;
    }
  }

  private async launchIsolatedBrowser(options: LaunchOptions): Promise<void> {
    try {
      this.browser = await chromium.launch({
        channel: "chrome",
        headless: options.headless,
      });
    } catch {
      this.browser = await chromium.launch({
        headless: options.headless,
      });
    }

    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    this.mode = "local";
  }

  async newPage(): Promise<Page> {
    if (!this.context) {
      throw new Error("Browser context is not initialized");
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }

    return this.page;
  }

  getPage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error("Page is not initialized");
    }

    return this.page;
  }

  getCurrentUrl(): string {
    const page = this.getPage();
    return page.url();
  }

  async goto(url: string, timeoutMs = 30000): Promise<void> {
    const page = this.getPage();
    await page.goto(url, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
  }

  async focusAddressBar(): Promise<void> {
    const page = this.getPage();
    const shortcut = process.platform === "darwin" ? "Meta+L" : "Control+L";
    await page.keyboard.press(shortcut);
  }

  async type(text: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.type(text);
  }

  async press(key: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(key);
  }

  async click(selector: string): Promise<void> {
    const page = this.getPage();
    await page.locator(selector).first().click();
  }

  async fill(selector: string, text: string): Promise<void> {
    const page = this.getPage();
    await page.locator(selector).first().fill(text);
  }

  async clickByText(text: string): Promise<void> {
    const page = this.getPage();
    await page.getByText(text, { exact: false }).first().click();
  }

  async waitForSelector(selector: string, timeout = 15000): Promise<void> {
    const page = this.getPage();
    await page.locator(selector).first().waitFor({ timeout, state: "visible" });
  }

  async waitForText(text: string, timeout = 15000): Promise<void> {
    const page = this.getPage();
    await page.getByText(text, { exact: false }).first().waitFor({ timeout });
  }

  async screenshotJpegBase64(quality = 60): Promise<string> {
    const page = this.getPage();
    const screenshot = await page.screenshot({
      type: "jpeg",
      quality,
      animations: "disabled",
    });
    return screenshot.toString("base64");
  }

  async close(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close();
      } catch {
        // Ignore tab-close errors during cleanup.
      }
    }

    this.page = undefined;

    if (this.mode === "cdp") {
      // Keep the user's existing Chrome session intact.
      return;
    }

    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // Ignore context-close errors during cleanup.
      }
    }

    this.context = undefined;

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Ignore browser-close errors during cleanup.
      }
    }

    this.browser = undefined;
    this.mode = undefined;
  }
}
