import { describe, expect, it } from "vitest";
import { appView, needsAuth, routeFor } from "../src/route";

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

describe("appView", () => {
  it.each([
    ["", "company"],
    ["?view=incidents", "incidents"],
    ["?view=plans&bundle=x", "plans"],
    ["?view=members", "members"],
    ["?view=nope", "company"],
  ])("%s opens %s", (search, expected) => {
    expect(appView(search)).toBe(expected);
  });
});
