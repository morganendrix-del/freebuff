const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*[A-Za-z]`, "g");

/** Removes terminal escape sequences so log parsing sees plain text. */
export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_PATTERN, "");
}

const URL_WITH_PORT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/gi;
const HOST_WITH_PORT = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi;
const LISTENING_PORT =
  /\b(?:listening|serving|running|started)\b[^\n]{0,40}?\bport\b[^\d]{0,6}(\d{2,5})\b/gi;

function validPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * Extracts the preview port a dev server announced. Log output is the source of truth: a server that
 * prints its URL is reachable there, while a guessed framework default may not be.
 */
export function detectPreviewPort(text: string): number | undefined {
  const clean = stripAnsi(text);

  for (const pattern of [URL_WITH_PORT, HOST_WITH_PORT, LISTENING_PORT]) {
    const matches = [...clean.matchAll(pattern)];
    const last = matches.at(-1);
    const port = validPort(last?.[1]);
    if (port !== undefined) return port;
  }

  return undefined;
}

const LOCAL_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "::", "::1", "localhost"]);

/** Normalises an announced URL to loopback, which is how the runtime reaches the preview server. */
export function normalizePreviewUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (LOCAL_HOSTS.has(parsed.hostname)) {
      parsed.hostname = "127.0.0.1";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
