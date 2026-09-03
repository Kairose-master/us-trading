import { describe, expect, it } from "vitest";
import { asBool } from "./config.js";

describe("asBool", () => {
  it("accepts every spelling Railway operators actually type", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on", " on "]) expect(asBool(v)).toBe(true);
    for (const v of ["false", "0", "no", "off", "", "maybe"]) expect(asBool(v)).toBe(false);
  });
});
