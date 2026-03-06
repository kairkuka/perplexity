import type { Step } from "../agent/steps.js";

const ALLOWED_DOMAINS = [
  "example.com",
  "wikipedia.org",
  "google.com",
];

function isAllowedDomain(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_DOMAINS.some((domain) => parsed.hostname.endsWith(domain));
  } catch {
    return false;
  }
}

function toAbsoluteUrl(url: string, base?: string): string {
  try {
    return new URL(url).toString();
  } catch {
    if (!base) {
      return url;
    }
    return new URL(url, base).toString();
  }
}

export function requiresApproval(step: Step, currentUrl?: string): boolean {
  if (step.type === "OPEN_URL") {
    return !isAllowedDomain(step.url);
  }

  if (step.type === "CLICK" && step.href) {
    const absoluteHref = toAbsoluteUrl(step.href, currentUrl);
    return !isAllowedDomain(absoluteHref);
  }

  if (step.type === "TYPE") {
    const selector = (step.selector ?? "").toLowerCase();
    if (
      selector.includes("password")
      || selector.includes("card")
      || selector.includes("cvv")
      || selector.includes("token")
    ) {
      return true;
    }
  }

  return false;
}
