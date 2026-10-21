"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Connection } from "@solana/web3.js";
import type { SignerInput } from "iqlabs-sdk/utils";
import { useVoiceCall } from "./useVoiceCall";

const VoiceCallContext = createContext<
  (ReturnType<typeof useVoiceCall> & { duration: number }) | null
>(null);

export function VoiceCallProvider({
  children,
  connection,
  signer,
  userPubkey,
}: {
  children: ReactNode;
  connection: Connection;
  signer: SignerInput | null;
  userPubkey: string | null;
}) {
  const voiceCall = useVoiceCall({ connection, signer, userPubkey });
  const [elapsed, setElapsed] = useState<{
    callId: string | null;
    seconds: number;
  }>({ callId: null, seconds: 0 });
  useEffect(() => {
    if (voiceCall.status !== "active") return;
    const started = Date.now();
    const timer = setInterval(
      () =>
        setElapsed({
          callId: voiceCall.callId,
          seconds: Math.floor((Date.now() - started) / 1000),
        }),
      1000,
    );
    return () => clearInterval(timer);
  }, [voiceCall.status, voiceCall.callId]);
  const duration =
    voiceCall.status === "active" && elapsed.callId === voiceCall.callId
      ? elapsed.seconds
      : 0;
  return (
    <VoiceCallContext.Provider value={{ ...voiceCall, duration }}>
      {children}
    </VoiceCallContext.Provider>
  );
}

export function useVoiceCallContext() {
  const context = useContext(VoiceCallContext);
  if (!context) throw new Error("Calls require VoiceCallProvider");
  return context;
}
