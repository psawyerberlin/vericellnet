import { afterEach, describe, expect, it } from "vitest";
import { ccc } from "@ckb-ccc/ccc";
import { makeClient } from "./client.js";

describe("makeClient", () => {
  afterEach(() => {
    delete process.env.VERICELL_DEVNET_RPC_URL;
  });

  it("builds a ClientPublicMainnet for mainnet", () => {
    expect(makeClient("mainnet")).toBeInstanceOf(ccc.ClientPublicMainnet);
  });

  it("builds a ClientPublicTestnet for testnet", () => {
    expect(makeClient("testnet")).toBeInstanceOf(ccc.ClientPublicTestnet);
  });

  it("builds a testnet-shaped client for devnet, pointed at the local offckb node by default", () => {
    const client = makeClient("devnet");
    expect(client).toBeInstanceOf(ccc.ClientPublicTestnet);
    expect(client.url).toBe("http://127.0.0.1:28114");
  });

  it("honors VERICELL_DEVNET_RPC_URL for devnet", () => {
    process.env.VERICELL_DEVNET_RPC_URL = "http://example.invalid:9999";
    const client = makeClient("devnet");
    expect(client.url).toBe("http://example.invalid:9999");
  });
});
