"use client";
import { type ReactNode, useMemo } from "react";
import { VoiceCallProvider } from "@/lib/voice/VoiceCallContext";
import { useAppConnection, useAppWallet } from "@/lib/wallet/use-app-wallet";
import { IncomingCallOverlay } from "./IncomingCallOverlay";
import { ActiveCallBar } from "./ActiveCallBar";

export function VoiceCallProviderWrapper({
  children,
}: {
  children: ReactNode;
}) {
  const { connection } = useAppConnection();
  const wallet = useAppWallet();
  const signer = useMemo(
    () =>
      wallet.connected && wallet.publicKey
        ? {
            publicKey: wallet.publicKey,
            signTransaction: wallet.signTransaction,
            signAllTransactions: wallet.signAllTransactions,
          }
        : null,
    [
      wallet.connected,
      wallet.publicKey,
      wallet.signTransaction,
      wallet.signAllTransactions,
    ],
  );
  return (
    <VoiceCallProvider
      key={wallet.publicKey?.toBase58() + "@" + connection.rpcEndpoint}
      connection={connection}
      signer={signer}
      userPubkey={wallet.publicKey?.toBase58() ?? null}
    >
      <IncomingCallOverlay />
      <ActiveCallBar />
      {children}
    </VoiceCallProvider>
  );
}
