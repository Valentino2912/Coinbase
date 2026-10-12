const express = require("express");
const cors    = require("cors");
const ethers  = require("ethers");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Constants ───────────────────────────────────────────────────────────────
const USDC    = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_ABI = [
  "function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external",
  "function balanceOf(address) view returns (uint256)"
];
const RWA_TYPES = [
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

// ─── Wallet B derivation ─────────────────────────────────────────────────────
function deriveWalletB() {
  const raw = (process.env.WALLET_B_KEY || "").trim();
  if (!raw) throw new Error("WALLET_B_KEY manquant dans .env");
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
      console.log(`[RPC OK] ${rpc}`);
      return base.connect(provider);
    } catch (e) {
      console.log(`[RPC KO] ${rpc} — ${e.message.slice(0, 40)}`);
    }
  }
  throw new Error("Tous les RPCs ont échoué");
}

// ─── POST /execute ────────────────────────────────────────────────────────────
// Body: { from, to, value, validAfter, validBefore, nonce, v, r, s }
app.post("/execute", async (req, res) => {
  const { from, to, value, validAfter, validBefore, nonce, v, r, s } = req.body;

  // 1. Validate required fields
  if (!from || !to || !value || !nonce || !v || !r || !s) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  // 2. Off-chain signature verification
  try {
    const domain    = { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC };
    const types     = { ReceiveWithAuthorization: RWA_TYPES };
    const message   = { from, to, value, validAfter, validBefore, nonce };
    const rawSig    = ethers.utils.joinSignature({ v: Number(v), r, s });
    const recovered = ethers.utils.verifyTypedData(domain, types, message, rawSig);

    if (recovered.toLowerCase() !== from.toLowerCase()) {
      return res.status(400).json({
        error: "Signature invalide",
        recovered,
        expected: from
      });
    }
    console.log(`[SIG OK] recovered = ${recovered}`);
  } catch (e) {
    return res.status(400).json({ error: "Erreur vérif signature : " + e.message });
  }

  // 3. Get Wallet B with live RPC
  let walletB;
  try {
    walletB = await getWalletB();
    console.log(`[WALLET B] ${walletB.address}`);
  } catch (e) {
    return res.status(500).json({ error: "Wallet B : " + e.message });
  }

  // 4. Check Wallet B is the `to` address
  if (walletB.address.toLowerCase() !== to.toLowerCase()) {
    return res.status(400).json({
      error: "Wallet B dérivé ne correspond pas au `to`",
      derived: walletB.address,
      expected: to
    });
  }

  const usdc = new ethers.Contract(USDC, USDC_ABI, walletB);

  // 5. Simulate (callStatic)
  try {
    await usdc.callStatic.receiveWithAuthorization(
      from, to, value, validAfter, validBefore, nonce, v, r, s
    );
    console.log("[SIMULATE OK]");
  } catch (e) {
    const reason = e?.reason || e?.data?.message || e?.error?.message || e?.message || String(e);
    return res.status(400).json({ error: "Simulation revert : " + reason });
  }

  // 6. Send TX
  try {
    const tx = await usdc.receiveWithAuthorization(
      from, to, value, validAfter, validBefore, nonce, v, r, s,
      { gasLimit: 150000 }
    );
    console.log(`[TX SENT] ${tx.hash}`);

    // Wait for 1 confirmation
    const rc = await tx.wait(1);
    console.log(`[TX CONFIRMED] bloc ${rc.blockNumber} gas ${rc.gasUsed.toString()}`);

    return res.json({
      success: true,
      txHash:      tx.hash,
      blockNumber: rc.blockNumber,
      gasUsed:     rc.gasUsed.toString()
    });
  } catch (e) {
    const msg = e?.data?.message || e?.reason || e?.error?.message || e?.message || String(e);
    return res.status(500).json({ error: "TX échouée : " + msg });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Pelican backend écoute sur :${PORT}`));
