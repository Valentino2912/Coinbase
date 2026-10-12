# PELICAN — EIP-3009 Full-Flow

**Wallet A signe** (Base App / Coinbase Wallet) → **Backend exécute** (Wallet B, clé privée sécurisée côté serveur)

## Structure

```
coinbase/
├── frontend/
│   └── index.html      # Page ouverte dans Base App — signe EIP-712
└── backend/
    ├── server.js        # Express — vérifie sig, appelle USDC on-chain
    ├── package.json
    └── .env.example     # Template — copier en .env avec la vraie clé
```

## Setup backend

```bash
cd backend
npm install
cp .env.example .env
# Éditer .env — mettre la clé privée ou phrase de récup de Wallet B
node server.js
```

## Config frontend

Dans `frontend/index.html`, ligne `const BACKEND = ...` :
- En local : `http://localhost:3000` (auto-détecté)
- En prod : remplacer par l'URL de ton serveur hébergé

## Flow

1. Ouvrir `frontend/index.html` dans Base App
2. Wallet A détecté automatiquement, solde USDC récupéré
3. Signature EIP-712 D1 déclenchée automatiquement
4. Signature envoyée au backend via `POST /execute`
5. Backend vérifie la signature off-chain, simule, envoie la TX avec Wallet B
6. Confirmation on-chain affichée

## Contrats

- **USDC Ethereum mainnet** : `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- **Méthode** : `receiveWithAuthorization` — EIP-3009, `msg.sender == to`
