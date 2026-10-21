# SolChat Web

A production-ready, decentralized messaging application built on Solana blockchain. This is the Next.js web version of SolChat, supporting Solana wallet extensions like Phantom, Solflare, and more

## Features

✨ **All Mobile App Features**:
- ✅ Decentralized, on-chain messaging via IQ Protocol
- Wallet-to-wallet DM text encryption using the IQ SDK
- ✅ Real-time message subscriptions
- ✅ Create and join chat rooms
- ✅ Send/receive SOL and BONK tokens
- ✅ Account management with balance display
- ✅ Terminal-style UI interface
- ✅ Multi-wallet support (Phantom, Solflare, Torus, Ledger)
- ✅ Message color customization
- ✅ Command-line interface for power users
- ✅ Devnet airdrop support
- ✅ **Mobile wallet support** (Phantom mobile, Solflare mobile)
- ✅ **Solana Saga/Seeker phone optimized**
- ✅ **Responsive design** for all screen sizes

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Blockchain**: Solana Web3.js
- **Wallet Adapter**: Solana Wallet Adapter
- **State Management**: TanStack React Query + React Context
- **Encryption**: IQ SDK X25519/HKDF/AES-GCM for DM text
- **Storage**: IQ Protocol (on-chain)

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- A Solana wallet extension (Phantom recommended)
- Devnet SOL for testing

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your API keys (see ENV_SETUP.md for details)
```

### Development

```bash
# Run development server
npm run dev

# Open http://localhost:3000
```

**First time setup?** See [ENV_SETUP.md](ENV_SETUP.md) for detailed configuration guide.

### Production Build

```bash
# Build for production
npm run build

# Start production server
npm start
```

## Environment Variables

```bash
# Quick setup
cp .env.example .env.local
```

The app is pre-configured with Devnet endpoints. To use your own RPC provider:

1. Get a free API key from [Helius](https://helius.dev) or [QuickNode](https://quicknode.com)
2. Update `NEXT_PUBLIC_RPC_URL` in `.env.local`

**See [ENV_SETUP.md](ENV_SETUP.md) for complete configuration guide.**

```env
NEXT_PUBLIC_IQ_BACKEND_HOST=https://iq-testbackend-381334931214.asia-northeast3.run.app
NEXT_PUBLIC_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
NEXT_PUBLIC_SOLANA_NETWORK=devnet
```

## Usage

### Connecting Wallet

**Desktop:**
1. Click "Select Wallet" in the navigation bar
2. Choose your preferred wallet (Phantom, Solflare, etc.)
3. Approve the connection in your wallet extension

**Mobile (Phantom/Solflare In-App Browser):**
1. Open Phantom or Solflare mobile app
2. Tap the browser/explore icon (🔍)
3. Navigate to your SolChat URL
4. Tap "Select Wallet" and approve connection
5. The app will automatically detect your mobile wallet!

**Solana Saga/Seeker Phones:**
1. Open the website in any browser
2. The wallet will be automatically injected
3. Click "Select Wallet" to connect
4. Enjoy seamless Web3 experience!

### Chat Features

Navigate to `/chat` to access the messaging interface.

**Main Menu**:
```
1 - Create/Search for a room
2 - Enter friend's room (via PDA)
3 - Enter Playground (test mode)
```

**Available Commands**:
```
/help                    - Show help message
/clear                   - Clear screen
/color [color]           - Change message color (blue/red/green/yellow)
/balance                 - Check wallet balance and tokens
/sendbonk [addr] [amt]   - Send BONK tokens
/leave                   - Exit current chat room
```

### Account Management

Navigate to `/account` to:
- View SOL and token balances
- Send SOL to other addresses
- Request devnet airdrops
- View all token accounts

## Architecture

### IQ Protocol Integration

SolChat uses the IQ Protocol to store messages permanently on Solana:

1. **Message Writing**: Messages are chunked and stored in Solana transactions
2. **Message Reading**: Historical messages fetched via transaction signatures
3. **Real-time Updates**: WebSocket subscription to account logs for live messages
4. **Data Integrity**: Merkle root verification for multi-chunk messages

### Wallet Integration

Supports all standard Solana wallet adapters:
- Phantom
- Solflare
- Torus
- Ledger

### Encryption

DM text uses the IQ SDK's multi-recipient encryption: a wallet message signature
recreates an X25519 key, the public key is published in profile metadata, and
sender/recipient keys can each unwrap the message key. New sends stop if either
key is unavailable; no silent plaintext fallback is allowed.

Public room messages are plaintext. DM sender, timestamp, recipient-key list,
and attachment URLs remain outside the encrypted text. Static wallet-derived
keys do not provide forward secrecy. This frontend does not implement the
legacy `/pw` room command or private-group membership/key rotation.
The Hanlock dependency alone does not establish those features.

### Calls

Approved DM contacts can call while both apps are open. Call offers and encrypted
SDP/ICE setup use the IQ calls table; audio, camera video and screen sharing use
browser WebRTC. Camera and screen sharing are optional after an audio call starts.
Media stops on hangup or wallet change. Signaling still needs wallet-signed
transactions and a working Solana RPC subscription. Google STUN is configured;
there is no TURN relay or closed-app push delivery. Recording/proof export is not
included.


## Deployment

### Vercel (Recommended)

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

## Security Considerations

- **Wallet Security**: Never share your private keys
- **Encryption**: Use strong encryption keys for sensitive messages
- **Devnet Only**: This version runs on Solana Devnet (test network)
- **Audit**: This is demonstration software - audit before production use

## Troubleshooting

### Wallet Connection Issues

- Ensure wallet extension is installed and unlocked
- Check that you're on the correct network (Devnet)
- Clear browser cache and reload

### Transaction Failures

- Ensure sufficient SOL balance for fees
- Check RPC endpoint is responding
- Verify network conditions

## License

MIT License

## Acknowledgments

- Built with [Next.js](https://nextjs.org/)
- Powered by [Solana](https://solana.com/)
- Wallet integration via [Solana Wallet Adapter](https://github.com/solana-labs/wallet-adapter)
- DM encryption primitives from the IQLabs SDK
- Based on the SolChat mobile app

---

**Built with ❤️ on Solana**
# solchat-web

## Read-path regression checks

With Bun installed, run `pnpm test` for gateway empty/error responses, room-list
error/loading states, offline DM encryption and wallet-key cache isolation, and
the notification relay protocol on an isolated loopback listener. Run `pnpm exec tsc
--noEmit` separately: this project currently skips TypeScript errors during its
Next production build. These tests do not perform wallet or on-chain writes.

`NEXT_PUBLIC_GATEWAY_URL` configures the default cached HTTP reader. Account
reads still use Solana RPC. A user-selected RPC takes precedence for app reads,
SDK fallbacks and friends reads; optional `NEXT_PUBLIC_HELIUS_RPC_URL` supplies
only the default read endpoint. One shared connection provider keeps all readers,
signing simulation and SDK fallbacks on the selected endpoint. Do not put private credentials in public env
variables. A failed root read now offers retry and the existing RPC editor.

## Transaction validation

The app keeps normal RPC submission preflight enabled. Single-transaction
signing first simulates the original message on the app's write RPC with
`sigVerify: false`; a failed simulation or unavailable RPC stops before asking
the wallet to sign. This adds one simulation request per single signing attempt,
with no background polling or automatic retry. Batch signing is unchanged:
dependent transactions cannot be independently simulated before earlier writes.

The local instruction sender confirms with the blockhash's validity window and
rejects instruction errors. If block-height confirmation expires, it checks the
signature once and accepts only a confirmed/finalized receipt without an error;
it never resends the transaction. It no longer uses a delayed read from a second RPC
to decide whether a confirmed write succeeded. Simulation logs remain attached
to the error's `cause` for debugging. Creation errors and room-read errors are
separate, so a rejected create does not invalidate a loaded room list.

This does not disable wallet approvals, suppress Phantom warnings, or add a
Lighthouse dependency. Phantom manages its own runtime assertions. A wallet's
simulation network must also match the app's target chain; local-validator
acceptance is not public-devnet or mainnet wallet acceptance.
