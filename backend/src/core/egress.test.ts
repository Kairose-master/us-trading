import { describe, expect, it } from "vitest";
import { parseTargets, proxyUrlFor, redactProxyUrl } from "./egress.js";

describe("egress proxy", () => {
  it("routes only listed targets, default upbit", () => {
    const env = { url: "http://fixie:pw@velodrome.usefixie.com:80", targets: "upbit" };
    expect(proxyUrlFor("upbit", env)).toBe(env.url);
    expect(proxyUrlFor("kis", env)).toBeNull();
    expect(proxyUrlFor("kis", { ...env, targets: "upbit, KIS" })).toBe(env.url);
  });
  it("is a no-op without a proxy url", () => {
    expect(proxyUrlFor("upbit", { url: "  ", targets: "upbit,kis" })).toBeNull();
  });
  it("ignores unknown targets", () => {
    expect(parseTargets("upbit,binance,, kis ")).toEqual(["upbit", "kis"]);
  });
  it("redacts credentials for status/logs", () => {
    expect(redactProxyUrl("http://fixie:secret@velodrome.usefixie.com:80")).toBe("http://velodrome.usefixie.com");
    expect(redactProxyUrl("nope")).toBe("(invalid url)");
  });
});
