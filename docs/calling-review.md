# Calling integration review

Draft review; no deployment, mainnet test, or new infrastructure is enabled.

## Current scope

Reuse SolChat's existing IQ accounts, approved DM relationships, wallet adapters,
SDK readers/writers, gateway notification, and account subscriptions. Calls begin
as audio; camera and screen sharing are optional. Signaling is on Solana, while
browser WebRTC carries encrypted media. This is not an entirely on-chain media
transport. Both parties must have the app open; no closed-app push service is
provided.

The integration addresses authenticated signal admission, bounded chunk reads,
failed confirmations, delayed wallet approval, cancellation/redial races,
autoplay recovery, camera release/reacquisition, and screen/hangup cleanup.
Recording and secret-key/proof export from the old branch are excluded.

## SDK dependency

The bounded reader change is [SDK PR #27](https://github.com/IQCoreTeam/iqlabs-solana-sdk/pull/27).
It adds optional byte/chunk/history limits to the existing decoder and exports
`ReadLimitError`, while preserving existing callers without limits. It targets
`feat/writerow-speed` independently of confirmation/retry PR #25. The combined
local QA artifact also included #25; the final release/pin must cover the required
changes rather than assuming the existing npm version contains them.

The integration is tested with a packed local build. Published SDK 0.3.6 does not
provide the new API. Before shipping, review/release the SDK changes and pin that
published version in the app, regenerate the lockfile and repeat the app checks.
Never ship the absolute local tarball override or QA wallet/chain configuration.
Connection-discovery PR #26 is a separate change, already submitted.

## TURN decision: deferred

The no-TURN checkpoint is `541c5bc` and branch
`codex/solchat-no-turn-checkpoint-20261021`. Optional TURN work is separate commit
`df23d27` on `codex/solchat-optional-turn-20261021`; it is not part of this proposal.

For now, keep the existing direct WebRTC/Google STUN path. This avoids requiring
a new relay operator, billing account, credential service or hosting arrangement.
No new relay operator or credential service is required by this draft. Google STUN is address discovery, not a TURN relay fallback.

Known consequences: calls can fail on restrictive NATs/firewalls; direct peers
can learn each other's public IP. STUN and RPC providers also see connection
metadata. Wallet identities and call-control records are public on Solana.
Do not describe this as anonymous or universally reliable calling.

## Future relay plan

1. Agree on the operator, funding/quotas, abuse policy and intended IP privacy.
   No protocol eliminates the need for someone to provide relay bandwidth.
2. Reuse standard coturn/eturnal or a managed TURN service. Keep IQ signaling;
   adopting the TURN credential pattern does not require adopting Matrix.
3. Provide an authenticated, rate-limited HTTPS credential issuer. Master keys
   remain server-side; only temporary TURN credentials reach the browser. The
   optional client candidate fetches credentials per call and fails closed on a
   configured issuer failure. Its loopback QA issuer must never be deployed.
4. Choose direct-with-relay-fallback (`all`) or relay-only (`relay`). Relay-only
   hides peer IPs from each other, not from the relay. The relay transports
   encrypted media but can observe IP addresses, timing and volume.
5. Cover supported call duration with credential lifetimes; test expiry,
   renewal/ICE restart, UDP and TCP/TLS fallback, cancellation and outages.
6. Prove the selected relay candidate pair in browser statistics, actual media
   delivery across different networks, physical mobile behavior, and cleanup.

Tessera is a separate future experiment: anonymous rate-limited admission could
protect credential issuance. It is not a TURN implementation or free relay
network; it needs a broker, review, and an operator. Its current research-grade,
unaudited status is not a basis for shipping privacy guarantees to SolChat users.

## Evidence and remaining acceptance

- No-TURN integration: 101 app tests; TypeScript and production build pass.
- Real Mac microphone/camera and native tab sharing were exercised locally;
  camera-off, native Stop Sharing and capture teardown were verified.
- Final no-TURN build connected two browser wallets through a local validator,
  exchanged synthetic audio/video and closed both peer connections.
- Optional TURN candidate: 107 app tests, TypeScript and calling-code lint pass.
  Local coturn UDP and TCP tests each relayed 60 packets with zero loss. These
  protocol tests do not prove forced-relay browser acceptance.
- Physical phone/wallet behavior, human listening, and cross-network calling
  remain unproven. Browser control was disabled during the optional relay review.
- Five existing explicit-any lint errors remain in two legacy files where this
  integration changes only supported transaction-version handling.

QA keys, media harnesses, credentials and receipts stay outside product source.

## References

- [Matrix TURN credential API](https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3voipturnserver)
- [Synapse TURN setup](https://element-hq.github.io/synapse/latest/turn-howto.html)
- [WebRTC TURN guidance](https://webrtc.org/getting-started/turn-server)
- [WebRTC IP handling](https://www.rfc-editor.org/rfc/rfc8828.html)
- [Tessera security status](https://github.com/NubsCarson/tessera/blob/main/SECURITY.md)
