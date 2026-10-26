/**
 * Which page to show. There is no router: three pages, told apart by the address.
 *
 *   /?replay=<id>        a saved run (public, static)
 *   /                    the landing page (public, static)
 *   /app, /?bundle=<id>  the review app (the example plans, or live plans once signed in)
 *
 * `/?bundle=…` stays the app so links shared before the landing page existed keep working.
 */
export type Route = "landing" | "replay" | "app";

export function routeFor(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  if (params.has("replay")) return "replay";
  const atRoot = pathname === "/" || pathname === "";
  if (atRoot && !params.has("bundle")) return "landing";
  return "app";
}

/** Only the app needs the sign-in provider; the other two pages are static. */
export const needsAuth = (route: Route) => route === "app";

/**
 * The signed-in app's sections, in the order a person works through them: their company, the
 * incidents they filed, the plans rehearsed from those, and (secondary) the members.
 *
 *   /app?view=company|incidents|plans|members
 */
export const APP_VIEWS = ["company", "incidents", "plans", "members"] as const;
export type AppView = (typeof APP_VIEWS)[number];

export function appView(search: string): AppView {
  const v = new URLSearchParams(search).get("view");
  return APP_VIEWS.find((x) => x === v) ?? "company";
}
