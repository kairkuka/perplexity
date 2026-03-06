import type { OutboundMessage } from "@agent/shared";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { executeSteps, StepExecutionFailedError, type StepExecutorDriver } from "../agent/executor.js";
import type { Step } from "../agent/steps.js";
import type { RuntimeConfig } from "../config.js";

const config: RuntimeConfig = {
  wsHost: "127.0.0.1",
  wsPort: 8787,
  frameFps: 1,
  screenshotQuality: 60,
  navigationTimeoutMs: 30000,
};

function createFakeDriver(gotoImpl: (url: string) => Promise<void>): StepExecutorDriver {
  return {
    goto: (url: string) => gotoImpl(url),
    getCurrentUrl: () => "about:blank",
    waitForSelector: async () => undefined,
    fill: async () => undefined,
    press: async () => undefined,
    waitForText: async () => undefined,
    getPage: () => ({}) as Page,
  };
}

describe("executeSteps", () => {
  it("retries failed step and succeeds on the last attempt", async () => {
    let attempts = 0;
    const driver = createFakeDriver(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`flaky-${attempts}`);
      }
    });

    const messages: OutboundMessage[] = [];
    const steps: Step[] = [{ type: "OPEN_URL", url: "https://example.com" }];

    await executeSteps({
      driver,
      config,
      steps,
      emitter: {
        emit: (message: OutboundMessage) => {
          messages.push(message);
        },
      },
    });

    expect(attempts).toBe(3);
    expect(messages.some((event) => event.type === "LOG" && event.message.includes("Retry 1/2"))).toBe(true);
    expect(messages.some((event) => event.type === "LOG" && event.message.includes("Retry 2/2"))).toBe(true);
    expect(messages.some((event) => event.type === "LOG" && event.message === "Step OK: OPEN_URL")).toBe(true);
  });

  it("emits STEP_FAILED after retries are exhausted", async () => {
    const driver = createFakeDriver(async () => {
      throw new Error("always fails");
    });

    const messages: OutboundMessage[] = [];

    await expect(
      executeSteps({
        driver,
        config,
        steps: [{ type: "OPEN_URL", url: "https://example.com" }],
        emitter: {
          emit: (message: OutboundMessage) => {
            messages.push(message);
          },
        },
      }),
    ).rejects.toBeInstanceOf(StepExecutionFailedError);

    expect(messages.some((event) => event.type === "ERROR" && event.code === "STEP_FAILED")).toBe(true);
    expect(messages.some((event) => event.type === "STATE" && event.status === "ERROR")).toBe(true);
  });

  it("pauses for safety approval and continues when approved", async () => {
    let gotoCalls = 0;
    const driver = createFakeDriver(async () => {
      gotoCalls += 1;
    });

    const messages: OutboundMessage[] = [];

    await executeSteps({
      driver,
      config,
      steps: [{ type: "OPEN_URL", url: "https://github.com" }],
      emitter: {
        emit: (message: OutboundMessage) => {
          messages.push(message);
        },
      },
      waitForApproval: async () => true,
    });

    expect(gotoCalls).toBe(1);
    expect(messages.some((event) => event.type === "NEED_APPROVAL")).toBe(true);
    expect(messages.some((event) => event.type === "STATE" && event.status === "PAUSED")).toBe(true);
    expect(messages.some((event) => event.type === "LOG" && event.message === "User approved step")).toBe(true);
    expect(messages.some((event) => event.type === "LOG" && event.message === "Step OK: OPEN_URL")).toBe(true);
  });

  it("fails with SAFETY_DENIED when approval is denied", async () => {
    let gotoCalls = 0;
    const driver = createFakeDriver(async () => {
      gotoCalls += 1;
    });

    const messages: OutboundMessage[] = [];

    await expect(
      executeSteps({
        driver,
        config,
        steps: [{ type: "OPEN_URL", url: "https://github.com" }],
        emitter: {
          emit: (message: OutboundMessage) => {
            messages.push(message);
          },
        },
        waitForApproval: async () => false,
      }),
    ).rejects.toBeInstanceOf(StepExecutionFailedError);

    expect(gotoCalls).toBe(0);
    expect(messages.some((event) => event.type === "ERROR" && event.code === "SAFETY_DENIED")).toBe(true);
    expect(messages.some((event) => event.type === "STATE" && event.status === "ERROR")).toBe(true);
  });
});
