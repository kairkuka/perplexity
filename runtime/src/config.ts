function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export interface RuntimeConfig {
  wsPort: number;
  wsHost: string;
  frameFps: number;
  screenshotQuality: number;
  navigationTimeoutMs: number;
}

export function loadConfig(): RuntimeConfig {
  return {
    wsPort: parseNumber(process.env.WS_PORT, 8787),
    wsHost: process.env.WS_HOST ?? "127.0.0.1",
    frameFps: Math.min(parseNumber(process.env.FRAME_FPS, 1), 2),
    screenshotQuality: Math.min(parseNumber(process.env.SCREENSHOT_QUALITY, 60), 100),
    navigationTimeoutMs: parseNumber(process.env.NAVIGATION_TIMEOUT_MS, 30000),
  };
}
