"use client";

/**
 * IncomingCallOverlay Component
 *
 * Full-screen overlay that appears when there's an incoming call.
 * Uses the global VoiceCallContext to detect and respond to calls.
 */

import { PhoneIcon, PhoneOffIcon, ChainIcon } from "./call-icons";
import { useVoiceCallContext } from "@/lib/voice/VoiceCallContext";

// Icons

export function IncomingCallOverlay() {
  const voiceCall = useVoiceCallContext();

  // Not in provider or no incoming call
  if (voiceCall.status !== "incoming") {
    return null;
  }

  const { remotePubkey, acceptCall, rejectCall } = voiceCall;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[9999] overflow-y-auto p-4">
      <div className="bg-gray-900 border-2 border-green-500 rounded-lg p-4 sm:p-8 flex flex-col items-center gap-6 w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-center gap-2 text-green-400">
          <ChainIcon />
          <span className="text-xs uppercase tracking-wider">
            On-Chain Call
          </span>
        </div>
        <div className="animate-pulse">
          <PhoneIcon />
        </div>
        <div className="text-center">
          <h2 className="text-xl font-bold text-white">Incoming Call</h2>
          <p className="text-gray-400 mt-1 font-mono text-sm">
            {remotePubkey?.slice(0, 8)}...{remotePubkey?.slice(-4)}
          </p>
        </div>
        <div className="grid grid-cols-1 min-[360px]:grid-cols-3 gap-3 w-full">
          <button
            onClick={() => rejectCall()}
            className="flex items-center justify-center gap-2 px-2 py-3 min-h-11 rounded-full bg-red-600 hover:bg-red-700 text-white font-medium transition-colors"
          >
            <PhoneOffIcon />
            Decline
          </button>

          <button
            onClick={() => acceptCall(false)}
            className="flex items-center justify-center gap-2 px-2 py-3 min-h-11 rounded-full bg-green-600 hover:bg-green-700 text-white font-medium transition-colors"
          >
            <PhoneIcon />
            Audio
          </button>

          <button
            onClick={() => acceptCall(true)}
            className="flex items-center justify-center gap-2 px-2 py-3 min-h-11 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
            Video
          </button>
        </div>
      </div>
    </div>
  );
}
