"use client";

/**
 * ActiveCallBar Component
 *
 * Fixed bar at the top of the screen during an active call.
 * Shows call status, duration, mute toggle, video toggle, screen sharing, and end call button.
 */

import { useRef, useEffect, useState } from "react";
import { PhoneIcon, PhoneOffIcon, ChainIcon } from "./call-icons";
import { useVoiceCallContext } from "@/lib/voice/VoiceCallContext";

// Icons

const MicIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
  </svg>
);

const MicOffIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
  </svg>
);

const VideoIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
  </svg>
);

const VideoOffIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2zM5 7h1.27l10 10H5V7z" />
  </svg>
);

const ScreenShareIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.11-.9-2-2-2H4c-1.11 0-2 .89-2 2v10c0 1.1.89 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" />
  </svg>
);

export function ActiveCallBar() {
  const voiceCall = useVoiceCallContext();

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const {
    status,
    remotePubkey,
    isMuted,
    isVideoEnabled,
    isScreenSharing,
    webrtcState,
    error,
    duration,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
    endCall,
    localStream,
    remoteStream,
  } = voiceCall;

  const hasRemoteVideo = !!remoteStream?.getVideoTracks().length;
  const hasLocalVideo = isVideoEnabled || isScreenSharing;
  const showVideoOverlay = hasRemoteVideo || hasLocalVideo;

  useEffect(() => {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    audio.srcObject = remoteStream;
    if (remoteStream) void audio.play().catch(() => setAudioBlocked(true));
    return () => {
      audio.srcObject = null;
    };
  }, [remoteStream, status]);

  // Attach streams to video elements
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [localStream, remoteStream, showVideoOverlay, isVideoEnabled]);

  if (status === "idle" && error)
    return (
      <div
        role="alert"
        className="fixed bottom-4 left-4 z-[9990] bg-black border border-red-500 p-3 text-white"
      >
        {error} <button onClick={() => void endCall()}>Dismiss</button>
      </div>
    );

  // Only show for active call states
  if (
    status !== "preparing" &&
    status !== "publishing" &&
    status !== "active" &&
    status !== "connecting" &&
    status !== "accepting" &&
    status !== "offering"
  ) {
    return null;
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getStatusText = (): string => {
    switch (status) {
      case "preparing":
        return "SETTING UP...";
      case "publishing":
        return "APPROVING CALL...";
      case "offering":
        return "CALLING...";
      case "accepting":
        return "ACCEPTING...";
      case "connecting":
        return "CONNECTING...";
      case "active":
        return webrtcState === "disconnected"
          ? "RECONNECTING..."
          : webrtcState === "connected"
            ? "CONNECTED"
            : "ACTIVE";
      default:
        return "CALLING...";
    }
  };

  return (
    <>
      <audio ref={remoteAudioRef} autoPlay />
      {audioBlocked && remoteStream && (
        <button
          className="fixed bottom-4 left-4 z-[9999] bg-black border border-green-500 p-3 text-white"
          onClick={() => {
            void remoteAudioRef.current
              ?.play()
              .then(() => setAudioBlocked(false));
          }}
        >
          Play call audio
        </button>
      )}
      {/* Video Overlay - Only show if there is actual video */}
      {showVideoOverlay && (
        <div
          className={`fixed border-2 border-gray-700 bg-black rounded-lg overflow-hidden shadow-2xl z-[9990] flex flex-col transition-all duration-300 ease-in-out
          ${
            isExpanded
              ? "inset-0 top-[52px] bottom-0 left-0 right-0 w-full h-auto rounded-none border-0"
              : "bottom-20 right-4 w-72 h-48"
          }`}
        >
          {/* Remote Video (Main) */}
          <div className="flex-1 relative bg-gray-900 flex items-center justify-center overflow-hidden">
            {remoteStream ? (
              <video
                ref={remoteVideoRef}
                muted
                autoPlay
                playsInline
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center text-gray-500 text-xs">
                <span className="animate-pulse">
                  Waiting for remote video...
                </span>
              </div>
            )}

            {/* Expand/Collapse Toggle */}
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="absolute top-2 right-2 p-1.5 bg-black/50 hover:bg-black/80 text-white rounded cursor-pointer z-50 transition-colors"
              title={isExpanded ? "Minimize" : "Maximize"}
            >
              {isExpanded ? (
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 14h6m0 0v6m0-6L3 21m20-11h-6m0 0V4m0 6L21 3M10 4H4m0 0v6m0-6L3 3m11 11h6m0 0v6m0-6L21 21"
                  />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                  />
                </svg>
              )}
            </button>

            {/* Local Video (PIP) */}
            {localStream && isVideoEnabled && (
              <div
                className={`absolute bottom-4 right-4 bg-gray-900 border border-gray-600 rounded overflow-hidden shadow-lg transform rotate-y-180 z-40 transition-all duration-300
                ${isExpanded ? "w-48 h-32" : "w-24 h-16"}
              `}
              >
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="fixed top-0 left-0 right-0 bg-green-700 text-white py-2 px-4 flex items-center justify-between z-[9999]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-green-200">
            <ChainIcon />
            <span className="text-xs">ON-CHAIN</span>
          </div>
          <div className="flex items-center gap-2">
            <PhoneIcon />
            {isMuted ? <MicOffIcon /> : <MicIcon />}
          </div>
          <span className="font-medium font-mono">
            {remotePubkey?.slice(0, 8)}...
          </span>
          {status === "active" && (
            <span className="text-green-200">{formatDuration(duration)}</span>
          )}
          <span className="text-green-200 text-xs uppercase">
            [{getStatusText()}]
          </span>
          {error && <span className="text-red-200 text-xs ml-2">{error}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMute}
            disabled={status !== "active"}
            className={`p-2 rounded-full transition-colors ${
              isMuted
                ? "bg-red-500 hover:bg-red-600"
                : "bg-gray-600 hover:bg-gray-700"
            }`}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <MicOffIcon /> : <MicIcon />}
          </button>

          <button
            onClick={toggleVideo}
            disabled={status !== "active"}
            className={`p-2 rounded-full transition-colors ${
              isVideoEnabled
                ? "bg-green-600 hover:bg-green-700"
                : "bg-gray-600 hover:bg-gray-700"
            }`}
            title={isVideoEnabled ? "Stop Video" : "Start Video"}
          >
            {isVideoEnabled ? <VideoIcon /> : <VideoOffIcon />}
          </button>

          <button
            onClick={() => toggleScreenShare()}
            className={`p-2 rounded-full transition-colors ${
              isScreenSharing
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-gray-600 hover:bg-gray-700"
            }`}
            disabled={status !== "active"}
            title={isScreenSharing ? "Stop Sharing" : "Share Screen"}
          >
            <ScreenShareIcon />
          </button>

          <button
            onClick={endCall}
            className="flex items-center gap-2 px-4 py-1 rounded-full bg-red-500 hover:bg-red-600 transition-colors"
          >
            <PhoneOffIcon />
            End
          </button>
        </div>
      </div>
    </>
  );
}
