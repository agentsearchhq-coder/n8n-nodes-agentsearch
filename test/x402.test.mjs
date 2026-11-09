// Vectors in x402-vectors.json were produced by the reference @x402/core 2.26 + @x402/evm + viem client
// (fixed clock and nonce) against the portal's real 402 terms for agentsearch-web-extract-v1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const x = require("../dist/nodes/AgentSearch/x402.js");
const { required, vectors } = JSON.parse(readFileSync(new URL("./x402-vectors.json", import.meta.url)));

test("keccak256 known answers", () => {
  assert.equal(x.toHex(x.keccak256(new Uint8Array())), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(x.toHex(x.keccak256(Buffer.from("abc"))), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});

test("address derivation + EIP-55", () => {
  assert.equal(x.addressOf(1n), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  assert.equal(x.checksumAddress("0xf732ea490c5766071785a2310523f7fa2cebb829"), "0xF732ea490c5766071785a2310523f7fA2CEbB829");
});

for (const v of vectors) {
  test(`payment payload matches reference x402 client (${v.from})`, () => {
    const { payload, from } = x.createPaymentPayload(required, required.accepts[0], x.parsePrivateKey(v.key), { now: v.now, nonce: v.nonce });
    assert.equal(from, v.from);
    assert.equal(payload.x402Version, 2);
    assert.equal(payload.payload.signature, v.signature);
    assert.deepEqual(payload.payload.authorization, {
      from: v.from, to: "0xF732ea490c5766071785a2310523f7fA2CEbB829", value: "5000", validAfter: "0", validBefore: String(v.now + 60), nonce: v.nonce,
    });
    assert.deepEqual(payload.accepted, required.accepts[0]);
    assert.deepEqual(payload.resource, required.resource);
    const decoded = JSON.parse(Buffer.from(x.encodePaymentHeader(payload), "base64").toString());
    assert.deepEqual(decoded, JSON.parse(JSON.stringify(payload)));
  });
}

test("selectAccept refuses wrong payee, asset, network or amount", () => {
  const ok = required.accepts[0];
  assert.equal(x.selectAccept([ok], 5000n), ok);
  assert.throws(() => x.selectAccept([{ ...ok, payTo: "0x0000000000000000000000000000000000000001" }], 5000n), /Nothing was signed/);
  assert.throws(() => x.selectAccept([{ ...ok, asset: "0x0000000000000000000000000000000000000002" }], 5000n), /not USDC/);
  assert.throws(() => x.selectAccept([{ ...ok, network: "eip155:1" }], 5000n), /network/);
  assert.throws(() => x.selectAccept([{ ...ok, amount: "5001" }], 5000n), /above/);
  assert.throws(() => x.selectAccept([ok], 4999n), /above/);
});

test("parsePrivateKey rejects bad keys without echoing them", () => {
  assert.throws(() => x.parsePrivateKey("nothex-secret"), (e) => !e.message.includes("nothex-secret"));
  assert.throws(() => x.parsePrivateKey("0x" + "0".repeat(64)), /out of range/);
});
