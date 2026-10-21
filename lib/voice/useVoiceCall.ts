"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Connection } from "@solana/web3.js";
import type { SignerInput } from "iqlabs-sdk/utils";
import { getCachedSignatures, invalidateSignatureCache } from "@/lib/rpc/cache";
import { useAccountSubscription } from "@/lib/shared/use-account-subscription";
import {
  callsTable,
  ensureCallsTable,
  readCallSignal,
  sendSignal,
} from "./call-signaling";
import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_OFFER_TIMEOUT_MS,
  type CallSignal,
  type CallStatus,
} from "./types";
import {
  generateEncryptionKeypair,
  encryptForRecipient,
  decryptFromSender,
  uint8ArrayToHex,
  hexToUint8Array,
} from "./encryption";
import { WebRTCManager } from "./webrtc-manager";

export function useVoiceCall({
  connection,
  signer,
  userPubkey,
}: {
  connection: Connection;
  signer: SignerInput | null;
  userPubkey: string | null;
}) {
  const [state, setState] = useState<{
    status: CallStatus;
    callId: string | null;
    remotePubkey: string | null;
    isOutgoing: boolean;
    error: string | null;
  }>({
    status: "idle",
    callId: null,
    remotePubkey: null,
    isOutgoing: false,
    error: null,
  });
  const stateRef = useRef(state);
  const [isMuted, setMuted] = useState(false);
  const [isVideoEnabled, setVideoEnabled] = useState(false);
  const [isScreenSharing, setScreenSharing] = useState(false);
  const [webrtcState, setWebrtcState] = useState<RTCPeerConnectionState>("new");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const manager = useRef<WebRTCManager | null>(null);
  const mediaOperation = useRef(false);
  const keys = useRef<ReturnType<typeof generateEncryptionKeypair> | null>(
    null,
  );
  const remoteKey = useRef<Uint8Array | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const generation = useRef(0);
  const mounted = useRef(true);
  const sendQueue = useRef(Promise.resolve());
  const receiveQueue = useRef(Promise.resolve());
  const seen = useRef(new Set<string>());
  const [listenSince] = useState(() => Date.now());
  const signerRef = useRef(signer);
  useEffect(() => {
    signerRef.current = signer;
  }, [signer]);

  const transition = useCallback((next: Partial<typeof state>) => {
    stateRef.current = { ...stateRef.current, ...next };
    setState(stateRef.current);
  }, []);

  const cleanup = useCallback(
    (error: string | null = null) => {
      generation.current++;
      manager.current?.cleanup();
      manager.current = null;
      keys.current = null;
      remoteKey.current = null;
      pendingCandidates.current = [];
      setLocalStream(null);
      setRemoteStream(null);
      setMuted(false);
      setVideoEnabled(false);
      setScreenSharing(false);
      setWebrtcState("closed");
      transition({
        status: "idle",
        callId: null,
        remotePubkey: null,
        isOutgoing: false,
        error,
      });
    },
    [transition],
  );

  const emit = useCallback(
    async (signal: CallSignal) => {
      const currentSigner = signerRef.current;
      if (
        !mounted.current ||
        !currentSigner ||
        currentSigner.publicKey.toBase58() !== signal.from
      )
        throw new Error("Call wallet changed");
      const epoch = generation.current;
      const result = sendQueue.current.then(async () => {
        if (!mounted.current || epoch !== generation.current) return;
        if (signal.type === "call-offer") transition({ status: "publishing" });
        await sendSignal(connection, currentSigner, signal);
      });
      sendQueue.current = result.catch(() => undefined);
      await result;
    },
    [connection, transition],
  );

  const sendEncrypted = useCallback(
    async (
      type: "sdp-offer" | "sdp-answer" | "ice-candidate",
      value: string,
    ) => {
      const current = stateRef.current;
      if (
        !keys.current ||
        !remoteKey.current ||
        !current.callId ||
        !current.remotePubkey ||
        !userPubkey
      )
        throw new Error("Call encryption is not ready");
      const encrypted = encryptForRecipient(
        value,
        remoteKey.current,
        keys.current.secretKey,
      );
      await emit({
        type,
        callId: current.callId,
        from: userPubkey,
        to: current.remotePubkey,
        timestamp: Date.now(),
        encrypted: true,
        nonce: encrypted.nonce,
        ...(type === "ice-candidate"
          ? { candidate: encrypted.encrypted }
          : { sdp: encrypted.encrypted }),
      });
    },
    [emit, userPubkey],
  );

  const initialize = useCallback(
    async (video: boolean) => {
      const epoch = generation.current;
      const instance = new WebRTCManager({
        onIceCandidates: (candidates) => {
          if (!mounted.current || generation.current !== epoch) return;
          pendingCandidates.current.push(
            ...candidates.map((candidate) => candidate.toJSON()),
          );
        },
        onConnectionStateChange: (status) => {
          if (generation.current !== epoch) return;
          setWebrtcState(status);
          if (status === "connected") transition({ status: "active" });
          else if (status === "failed")
            cleanup(
              "Could not connect this call. A relay may be needed on this network.",
            );
        },
        onLocalStream: (stream) => {
          if (generation.current === epoch) setLocalStream(stream);
        },
        onRemoteStream: (stream) => {
          if (generation.current === epoch) setRemoteStream(stream);
        },
        onScreenShareEnded: () => {
          if (mounted.current && generation.current === epoch) setScreenSharing(false);
        },
        onError: (message) => {
          if (generation.current === epoch) transition({ error: message });
        },
      });
      manager.current = instance;
      await instance.initialize(video);
      if (generation.current !== epoch) {
        instance.cleanup();
        return null;
      }
      setVideoEnabled(video);
      return instance;
    },
    [cleanup, transition],
  );

  // ICE gathering can finish before the SDP write. Drain only after the SDP is
  // queued, so no candidate can overtake its description on the chain.
  const flushCandidates = useCallback(async () => {
    if (!manager.current || !remoteKey.current) return;
    manager.current.flushIceCandidatesNow();
    if (pendingCandidates.current.length)
      await sendEncrypted(
        "ice-candidate",
        JSON.stringify(pendingCandidates.current.splice(0)),
      );
  }, [sendEncrypted]);

  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      if (!userPubkey || signal.to !== userPubkey || signal.from === userPubkey)
        return;
      const current = stateRef.current;
      const epoch = generation.current;
      if (
        signal.timestamp < listenSince - CALL_OFFER_TIMEOUT_MS ||
        signal.timestamp > Date.now() + 30000
      )
        return;
      if (signal.type === "call-offer") {
        if (Date.now() - signal.timestamp > CALL_OFFER_TIMEOUT_MS) return;
        if (current.status !== "idle") return;
        if (!signal.encPubKey || !/^[0-9a-f]{64}$/i.test(signal.encPubKey))
          return;
        remoteKey.current = hexToUint8Array(signal.encPubKey);
        transition({
          status: "incoming",
          callId: signal.callId,
          remotePubkey: signal.from,
          isOutgoing: false,
          error: null,
        });
        return;
      }
      if (
        signal.callId !== current.callId ||
        signal.from !== current.remotePubkey
      )
        return;
      if (["call-end", "call-reject", "call-busy"].includes(signal.type)) {
        cleanup();
        return;
      }
      if (signal.type === "call-accept") {
        if (
          !["publishing", "offering"].includes(current.status) ||
          !signal.encPubKey ||
          !/^[0-9a-f]{64}$/i.test(signal.encPubKey)
        )
          return;
        remoteKey.current = hexToUint8Array(signal.encPubKey);
        transition({ status: "connecting" });
        const instance = manager.current;
        if (!instance) return;
        const offer = await instance.createOffer();
        if (!mounted.current || generation.current !== epoch) return;
        await sendEncrypted("sdp-offer", offer);
        if (mounted.current && generation.current === epoch) await flushCandidates();
        return;
      }
      if (
        !signal.encrypted ||
        !signal.nonce ||
        !keys.current ||
        !remoteKey.current
      )
        throw new Error("Unencrypted call setup was rejected");
      const payload =
        signal.type === "ice-candidate" ? signal.candidate : signal.sdp;
      if (!payload) return;
      const plain = decryptFromSender(
        payload,
        signal.nonce,
        remoteKey.current,
        keys.current.secretKey,
      );
      if (plain === null)
        throw new Error("Call setup could not be authenticated");
      if (
        signal.type === "sdp-offer" &&
        !current.isOutgoing &&
        manager.current
      ) {
        const answer = await manager.current.handleOffer(plain);
        if (!mounted.current || generation.current !== epoch) return;
        await sendEncrypted("sdp-answer", answer);
        if (mounted.current && generation.current === epoch) await flushCandidates();
      } else if (
        signal.type === "sdp-answer" &&
        current.isOutgoing &&
        manager.current
      ) {
        await manager.current.handleAnswer(plain);
        if (mounted.current && generation.current === epoch) await flushCandidates();
      } else if (signal.type === "ice-candidate" && manager.current) {
        const candidates = JSON.parse(plain);
        if (!Array.isArray(candidates) || candidates.length > 32)
          throw new Error("Invalid call candidates");
        for (const candidate of candidates) {
          if (!mounted.current || generation.current !== epoch) return;
          await manager.current?.addIceCandidate(candidate);
        }
      }
    },
    [
      cleanup,
      flushCandidates,
      sendEncrypted,
      transition,
      userPubkey,
      listenSince,
    ],
  );

  const receive = useCallback(
    async (signatures: string[]) => {
      const epoch = generation.current;
      // Serial processing preserves accept/SDP ordering across overlapping account notifications.
      const result = receiveQueue.current.then(async () => {
        for (const signature of signatures) {
          if (epoch !== generation.current || seen.current.has(signature))
            continue;
          const signal = await readCallSignal(connection, signature, {
            to: userPubkey!,
            since: Math.max(
              listenSince - CALL_OFFER_TIMEOUT_MS,
              Date.now() - CALL_CONNECT_TIMEOUT_MS,
            ),
            peer: stateRef.current.remotePubkey,
          });
          if (epoch !== generation.current) return;
          seen.current.add(signature);
          if (seen.current.size > 1000)
            seen.current.delete(seen.current.values().next().value!);
          if (signal) await handleSignal(signal);
        }
      });
      const handled = result.catch((error) => {
        if (mounted.current && epoch === generation.current)
          transition({
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      });
      receiveQueue.current = handled.catch(() => undefined);
      await handled;
    },
    [connection, transition, handleSignal, userPubkey, listenSince],
  );

  useAccountSubscription({
    connection,
    account: callsTable,
    onNewSignatures: receive,
    enabled: !!userPubkey,
    fetchLimit: 30,
    logPrefix: "CallSignals",
  });

  useEffect(() => {
    if (!userPubkey) return;
    let active = true;
    let lastCatchUp = 0;
    const catchUp = async () => {
      if (
        document.visibilityState === "hidden" ||
        Date.now() - lastCatchUp < 1000
      )
        return;
      lastCatchUp = Date.now();
      const epoch = generation.current;
      try {
        invalidateSignatureCache(callsTable.toBase58());
        const signatures = await getCachedSignatures(
          connection,
          callsTable,
          30,
        );
        if (active && mounted.current && epoch === generation.current)
          await receive(
            signatures
              .filter(
                (value) =>
                  !value.err &&
                  value.blockTime != null &&
                  value.blockTime * 1000 >=
                    Date.now() - CALL_OFFER_TIMEOUT_MS - 1000,
              )
              .map((value) => value.signature)
              .reverse(),
          );
      } catch (error) {
        if (active && mounted.current && epoch === generation.current)
          transition({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    };
    void catchUp();
    window.addEventListener("online", catchUp);
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      active = false;
      window.removeEventListener("online", catchUp);
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [connection, userPubkey, receive, transition, listenSince]);

  useEffect(() => {
    if (!["offering", "incoming", "connecting"].includes(state.status)) return;
    const timeout = setTimeout(
      () =>
        cleanup(
          state.status === "connecting"
            ? "Call connection timed out"
            : "Call was not answered",
        ),
      state.status === "connecting"
        ? CALL_CONNECT_TIMEOUT_MS
        : CALL_OFFER_TIMEOUT_MS,
    );
    return () => clearTimeout(timeout);
  }, [state.status, cleanup]);

  // Drain late ICE only while negotiating. No per-transaction history scan loop.
  useEffect(() => {
    if (state.status !== "connecting") return;
    const timer = setInterval(() => {
      void flushCandidates().catch((error) =>
        transition({ error: String(error) }),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [state.status, flushCandidates, transition]);

  useEffect(() => {
    if (state.status !== "active" || webrtcState !== "disconnected") return;
    // Allow a brief network interruption, but never leave a dead call active.
    const timer = setTimeout(() => cleanup("Call disconnected"), 10000);
    return () => clearTimeout(timer);
  }, [state.status, webrtcState, cleanup]);

  const dispose = useCallback(() => {
    mounted.current = false;
    generation.current++;
    keys.current = null;
    remoteKey.current = null;
    manager.current?.cleanup();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return dispose;
  }, [connection, userPubkey, dispose]);

  const startCall = useCallback(
    async (target: string) => {
      if (
        !signerRef.current ||
        !userPubkey ||
        stateRef.current.status !== "idle" ||
        target === userPubkey
      )
        return false;
      const epoch = generation.current;
      const callId = crypto.randomUUID();
      transition({
        status: "preparing",
        callId,
        remotePubkey: target,
        isOutgoing: true,
        error: null,
      });
      keys.current = generateEncryptionKeypair();
      try {
        await ensureCallsTable(connection, signerRef.current);
        if (!mounted.current || epoch !== generation.current) return false;
        if (!(await initialize(false))) return false;
        await emit({
          type: "call-offer",
          callId,
          from: userPubkey,
          to: target,
          timestamp: Date.now(),
          encPubKey: uint8ArrayToHex(keys.current!.publicKey),
        });
        if (!mounted.current || epoch !== generation.current) return false;
        if ((stateRef.current.status as CallStatus) === "publishing")
          transition({ status: "offering" });
        return true;
      } catch (error) {
        if (mounted.current && epoch === generation.current)
          cleanup(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [connection, userPubkey, transition, initialize, emit, cleanup],
  );

  const acceptCall = useCallback(
    async (video = false) => {
      const current = stateRef.current;
      if (
        !signerRef.current ||
        !userPubkey ||
        current.status !== "incoming" ||
        !current.callId ||
        !current.remotePubkey
      )
        return false;
      const epoch = generation.current;
      transition({ status: "accepting" });
      keys.current = generateEncryptionKeypair();
      try {
        if (!(await initialize(video))) return false;
        await emit({
          type: "call-accept",
          callId: current.callId,
          from: userPubkey,
          to: current.remotePubkey,
          timestamp: Date.now(),
          encPubKey: uint8ArrayToHex(keys.current!.publicKey),
        });
        if (!mounted.current || epoch !== generation.current) return false;
        if ((stateRef.current.status as CallStatus) === "accepting")
          transition({ status: "connecting" });
        return true;
      } catch (error) {
        if (mounted.current && epoch === generation.current)
          cleanup(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [userPubkey, initialize, transition, emit, cleanup],
  );

  const endCall = useCallback(async () => {
    const current = stateRef.current;
    const pendingWrites = sendQueue.current;
    const currentSigner = signerRef.current;
    cleanup();
    if (
      current.status !== "preparing" &&
      current.callId &&
      current.remotePubkey &&
      userPubkey &&
      currentSigner
    ) {
      // Close media immediately. Keep end in the queue so an immediate redial
      // cannot reach the recipient before this call has ended.
      const ending = pendingWrites.then(async () => {
        if (
          !mounted.current ||
          signerRef.current?.publicKey.toBase58() !== userPubkey
        )
          return;
        await sendSignal(connection, currentSigner, {
          type: current.status === "incoming" ? "call-reject" : "call-end",
          callId: current.callId!,
          from: userPubkey,
          to: current.remotePubkey!,
          timestamp: Date.now(),
        });
      });
      sendQueue.current = ending.catch(() => undefined);
      try {
        await ending;
      } catch (error) {
        if (mounted.current && stateRef.current.status === "idle")
          transition({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    }
  }, [cleanup, connection, transition, userPubkey]);

  const toggleVideo = useCallback(async () => {
    if (mediaOperation.current || stateRef.current.status !== "active") return;
    mediaOperation.current = true;
    const epoch = generation.current;
    try {
      await manager.current?.setVideoEnabled(!isVideoEnabled);
      if (epoch === generation.current) setVideoEnabled(!isVideoEnabled);
    } catch (error) {
      if (epoch === generation.current)
        transition({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      mediaOperation.current = false;
    }
  }, [isVideoEnabled, transition]);
  const toggleScreenShare = useCallback(async () => {
    if (mediaOperation.current || stateRef.current.status !== "active") return;
    mediaOperation.current = true;
    const epoch = generation.current;
    try {
      if (isScreenSharing) await manager.current?.stopScreenShare();
      else {
        await manager.current?.startScreenShare();
        if (epoch === generation.current) setScreenSharing(true);
      }
    } catch (error) {
      if (epoch === generation.current)
        transition({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      mediaOperation.current = false;
    }
  }, [isScreenSharing, transition]);

  return {
    ...state,
    isMuted,
    isVideoEnabled,
    isScreenSharing,
    webrtcState,
    localStream,
    remoteStream,
    isReady: !!signer,
    startCall,
    acceptCall,
    rejectCall: endCall,
    endCall,
    toggleVideo,
    toggleScreenShare,
    toggleMute: () => {
      manager.current?.setMuted(!isMuted);
      setMuted(!isMuted);
    },
  };
}
