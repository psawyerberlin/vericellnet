import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env.VERICELL_NETWORK;

async function importFresh() {
  vi.resetModules();
  return import("./network.js");
}

describe("network", () => {
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.VERICELL_NETWORK;
    } else {
      process.env.VERICELL_NETWORK = ORIGINAL_ENV;
    }
    vi.resetModules();
  });

  it("defaults to testnet when no env is set", async () => {
    delete process.env.VERICELL_NETWORK;
    const { NETWORK, isMainnet } = await importFresh();
    expect(NETWORK).toBe("testnet");
    expect(isMainnet()).toBe(false);
  });

  it("reads VERICELL_NETWORK from process.env", async () => {
    process.env.VERICELL_NETWORK = "devnet";
    const { NETWORK } = await importFresh();
    expect(NETWORK).toBe("devnet");
  });

  it("reports mainnet correctly and picks the mainnet explorer URL", async () => {
    process.env.VERICELL_NETWORK = "mainnet";
    const { NETWORK, EXPLORER_URL, isMainnet } = await importFresh();
    expect(NETWORK).toBe("mainnet");
    expect(isMainnet()).toBe(true);
    expect(EXPLORER_URL).toBe("https://explorer.nervos.org");
  });

  it("falls back to testnet for an invalid env value", async () => {
    process.env.VERICELL_NETWORK = "not-a-real-network";
    const { NETWORK } = await importFresh();
    expect(NETWORK).toBe("testnet");
  });

  it("has a testnet explorer URL matching the default network", async () => {
    delete process.env.VERICELL_NETWORK;
    const { EXPLORER_URL } = await importFresh();
    expect(EXPLORER_URL).toBe("https://testnet.explorer.nervos.org");
  });

  it("explorerUrlForNetwork resolves any network regardless of the build-time default", async () => {
    delete process.env.VERICELL_NETWORK;
    const { explorerUrlForNetwork } = await importFresh();
    expect(explorerUrlForNetwork("mainnet")).toBe("https://explorer.nervos.org");
    expect(explorerUrlForNetwork("testnet")).toBe("https://testnet.explorer.nervos.org");
    expect(explorerUrlForNetwork("devnet")).toBe("http://localhost:8114-local");
  });
});
