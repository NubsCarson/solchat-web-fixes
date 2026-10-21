"use client";

/**
 * DMCallButton Component
 *
 * Call button for DM chat view. Starts a call with the friend
 * you're currently chatting with - no need to enter their address.
 */

import { PhoneIcon, ChainIcon } from "./call-icons";
import { useVoiceCallContext } from "@/lib/voice/VoiceCallContext";

// Icons

export function DMCallButton({
  targetPubkey,
  disabled,
}: {
  targetPubkey: string;
  disabled?: boolean;
}) {
  const voiceCall = useVoiceCallContext();

  const { status, isReady } = voiceCall;

  // Already in a call
  if (status !== "idle") {
    return null;
  }

  const isDisabled = disabled || !isReady;

  return (
    <button
      onClick={() => void voiceCall.startCall(targetPubkey)}
      disabled={isDisabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors
        ${
          isDisabled
            ? "bg-gray-700 text-gray-500 cursor-not-allowed"
            : "bg-green-600 hover:bg-green-700 text-white"
        }`}
      title={isReady ? "Start voice call" : "Initializing..."}
    >
      <ChainIcon />
      <PhoneIcon className="w-4 h-4" />
      <span>{isReady ? "CALL" : "INIT..."}</span>
    </button>
  );
}
