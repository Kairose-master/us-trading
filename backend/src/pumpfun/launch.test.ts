import { describe, expect, it } from "vitest";
import { base58, newMintKeypair } from "./launch.js";

describe("launch keypair", () => {
  it("base58 matches known vectors", () => {
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58(Buffer.from("hello"))).toBe("Cn8eVZg");
  });
  it("makes a Solana-shaped keypair: 32-byte pubkey and 64-byte secret, base58", () => {
    const k = newMintKeypair();
    expect(k.publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(k.secretKeyB58).toMatch(/^[1-9A-HJ-NP-Za-km-z]{85,90}$/);
  });
});
