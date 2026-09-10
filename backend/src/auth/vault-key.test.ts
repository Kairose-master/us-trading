import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// data/ 아래에 키를 만들므로 임시 cwd에서 돈다. config는 env가 비어 있어야 파일 경로를 탄다
const dir = mkdtempSync(join(tmpdir(), "vault-key-"));
beforeAll(() => { process.chdir(dir); delete process.env.CREDENTIALS_MASTER_KEY; });

describe("vault master key without env", () => {
  it("generates a 32-byte key file on first use, reuses it, and round-trips seal/open", async () => {
    const { vaultKey, seal, open } = await import("./crypto.js");
    const k1 = vaultKey();
    expect(k1).not.toBeNull();
    expect(k1!.length).toBe(32);
    const file = join(dir, "data", "vault-master.key");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const sealed = seal({ accessKey: "a", secretKey: "b" }, "u1:upbit");
    expect(open(sealed, "u1:upbit")).toEqual({ accessKey: "a", secretKey: "b" });
    rmSync(dir, { recursive: true, force: true });
  });
});
