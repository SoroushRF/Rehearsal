import { describe, expect, it } from "vitest";
import { needsAuth, routeFor } from "../src/route";

describe("routeFor", () => {
  it.each([
    ["/", "", "landing"],
    ["", "", "landing"],
    ["/", "?utm_source=x", "landing"],
    ["/app", "", "app"],
    ["/app", "?bundle=phantom", "app"],
    ["/", "?bundle=phantom", "app"],
    ["/", "?replay=phantom", "replay"],
    ["/", "?replay=", "replay"],
    ["/app", "?replay=phantom", "replay"],
    ["/plans/review", "", "app"],
  ])("%s%s is the %s page", (pathname, search, expected) => {
    expect(routeFor(pathname, search)).toBe(expected);
  });

  it("loads the sign-in provider only for the app", () => {
    expect(needsAuth("app")).toBe(true);
    expect(needsAuth("landing")).toBe(false);
    expect(needsAuth("replay")).toBe(false);
  });
});
