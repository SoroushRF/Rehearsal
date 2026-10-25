/** The API's default port. `.env` can change it with API_PORT, and the dev proxy must follow. */
export const DEFAULT_API_PORT = 3000;

/**
 * Where the dev server forwards `/api`. A missing, empty or invalid port falls back to the default
 * rather than pointing the proxy at something that can't be reached.
 */
export function apiOrigin(port: string | undefined): string {
  const n = Number(port);
  const valid =
    port !== undefined && port.trim() !== "" && Number.isInteger(n) && n > 0 && n < 65536;
  return `http://localhost:${valid ? n : DEFAULT_API_PORT}`;
}
