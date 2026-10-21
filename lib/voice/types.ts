/**
 * Voice Call Types and Constants
 * Full on-chain signaling with WebRTC audio
 */

// ============================================================================
// Call Signaling Types (written on-chain)
// ============================================================================

export interface CallSignal {
  type:
    | "call-offer" // Caller initiates
    | "call-accept" // Callee accepts
    | "call-reject" // Callee rejects
    | "call-end" // Either party ends
    | "call-busy" // Callee is busy
    | "sdp-offer" // WebRTC SDP offer
    | "sdp-answer" // WebRTC SDP answer
    | "ice-candidate";
  callId: string;
  from: string; // sender wallet pubkey
  to: string; // recipient wallet pubkey
  timestamp: number;
  // Optional fields based on type
  sdp?: string; // For sdp-offer/sdp-answer (encrypted)
  candidate?: string; // For ice-candidate (JSON stringified, may be encrypted)
  // Encryption fields
  encPubKey?: string; // Sender's encryption public key (hex) - in call-offer/call-accept
  nonce?: string; // Nonce for encrypted data (base64)
  encrypted?: boolean; // True if sdp/candidate is encrypted
}

// ============================================================================
// Call State Machine
// ============================================================================

export type CallStatus =
  | "idle"
  | "preparing"
  | "publishing" // Offer awaits wallet approval and confirmation
  | "offering" // We sent offer, waiting for accept
  | "incoming" // We received offer
  | "accepting" // We're sending accept
  | "connecting" // Exchanging SDP/ICE
  | "active"; // Call is live

// ============================================================================
// Constants
// ============================================================================

// Table name for call signaling data
export const CALLS_TABLE_NAME = "voice-calls";

// Columns for the calls table
export const CALLS_COLUMNS = [
  "id",
  "type",
  "data",
  "sender",
  "timestamp",
] as const;

// How long to wait for call accept before timeout (ms)
export const CALL_OFFER_TIMEOUT_MS = 30000;

// How long to wait for SDP/ICE exchange (ms)
export const CALL_CONNECT_TIMEOUT_MS = 60000;

// ICE servers for WebRTC
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse call signal from on-chain data
 */
export function parseCallSignal(data: string): CallSignal | null {
  try {
    const parsed = JSON.parse(data);
    if (
      ![
        "call-offer",
        "call-accept",
        "call-reject",
        "call-end",
        "call-busy",
        "sdp-offer",
        "sdp-answer",
        "ice-candidate",
      ].includes(parsed.type) ||
      typeof parsed.callId !== "string" ||
      parsed.callId.length > 80 ||
      typeof parsed.from !== "string" ||
      typeof parsed.to !== "string" ||
      !Number.isFinite(parsed.timestamp)
    ) {
      return null;
    }
    return parsed as CallSignal;
  } catch {
    return null;
  }
}
