import type { FrameEvent } from "@agent/shared";

import { ChromeDriver } from "./chromeDriver.js";

interface ScreenshotStreamerOptions {
  fps: number;
  quality: number;
}

type FrameSender = (event: FrameEvent) => void;

export class ScreenshotStreamer {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(
    private readonly driver: ChromeDriver,
    private readonly sendFrame: FrameSender,
    private readonly options: ScreenshotStreamerOptions,
  ) {
    this.intervalMs = Math.max(500, Math.floor(1000 / Math.max(options.fps, 1)));
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.captureFrame();
    }, this.intervalMs);

    void this.captureFrame();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async captureFrame(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;

    try {
      const dataBase64 = await this.driver.screenshotJpegBase64(this.options.quality);
      this.sendFrame({
        type: "FRAME",
        ts: Date.now(),
        mime: "image/jpeg",
        dataBase64,
      });
    } catch {
      // Ignore frame capture errors when browser/page is not ready.
    } finally {
      this.inFlight = false;
    }
  }
}
