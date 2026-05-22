import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("plugin server entry loads", async () => {
    const plugin = (await import("../strapi-server.js")).default || require("../strapi-server.js");
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe("object");
  });
});
