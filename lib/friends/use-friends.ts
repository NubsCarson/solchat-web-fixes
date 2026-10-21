/**
 * Friends Data Hook
 * - Scans the user's UserState tx history for request_connection /
 *   manage_connection instructions and decodes the resulting Connection
 *   accounts. This catches BOTH incoming and outgoing requests, unlike
 *   iqlabs.reader.fetchUserConnections which currently skips incoming
 *   requests because the SDK's instruction coder mis-decodes them.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey, type Connection } from '@solana/web3.js';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { sha256 } from '@noble/hashes/sha2.js';
import iqlabs from 'iqlabs-sdk';
import type { Friend, FriendStatus } from './types';

export interface UseFriendsParams {
  userAddress: string | undefined;
  readConnection: Connection;
}

export interface UseFriendsReturn {
  friends: Friend[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const anchorDisc = (name: string): Uint8Array =>
  sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);

const REQUEST_CONNECTION_DISC = anchorDisc('request_connection');
const MANAGE_CONNECTION_DISC = anchorDisc('manage_connection');
const CONNECTION_TABLE_IX_INDEX = 3;
const TX_HISTORY_LIMIT = 200;

const bufEq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export function useFriends(params: UseFriendsParams): UseFriendsReturn {
  const { userAddress, readConnection } = params;

  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const programId = useMemo(
    () => new PublicKey(iqlabs.contract.DEFAULT_ANCHOR_PROGRAM_ID),
    []
  );

  const accountCoder = useMemo(
    () => new BorshAccountsCoder(iqlabs.contract.IQ_IDL),
    []
  );

  const fetchFriends = useCallback(async () => {
    if (!userAddress) {
      setFriends([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const owner = new PublicKey(userAddress);
      const ownerBase58 = owner.toBase58();
      const userState = iqlabs.contract.getUserPda(owner, programId);

      const sigs = await readConnection.getSignaturesForAddress(userState, {
        limit: TX_HISTORY_LIMIT,
      });

      const connectionPdas = new Map<string, number>();
      for (const sig of sigs) {
        let tx;
        try {
          tx = await readConnection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 1,
          });
        } catch {
          continue;
        }
        if (!tx) continue;
        const keys = tx.transaction.message.getAccountKeys();
        for (const ix of tx.transaction.message.compiledInstructions) {
          const programKey = keys.get(ix.programIdIndex);
          if (!programKey || !programKey.equals(programId)) continue;
          const disc = ix.data.slice(0, 8);
          if (
            !bufEq(disc, REQUEST_CONNECTION_DISC) &&
            !bufEq(disc, MANAGE_CONNECTION_DISC)
          ) {
            continue;
          }
          const ctGlobalIdx = ix.accountKeyIndexes[CONNECTION_TABLE_IX_INDEX];
          if (ctGlobalIdx === undefined) continue;
          const ctKey = keys.get(ctGlobalIdx);
          if (!ctKey) continue;
          const ctStr = ctKey.toBase58();
          const ts = sig.blockTime ?? 0;
          const prev = connectionPdas.get(ctStr) ?? 0;
          if (ts > prev) connectionPdas.set(ctStr, ts);
        }
      }

      const friendsList: Friend[] = [];
      for (const [pdaStr, lastTs] of Array.from(connectionPdas.entries())) {
        let info;
        try {
          info = await readConnection.getAccountInfo(new PublicKey(pdaStr));
        } catch {
          continue;
        }
        if (!info) continue;
        let decoded: any;
        try {
          decoded = accountCoder.decode('Connection', info.data);
        } catch {
          continue;
        }
        const partyA = new PublicKey(decoded.party_a).toBase58();
        const partyB = new PublicKey(decoded.party_b).toBase58();
        if (partyA !== ownerBase58 && partyB !== ownerBase58) continue;

        const dbRootId = Buffer.from(decoded.db_root_id)
          .toString('utf8')
          .replace(/\0+$/, '');

        const statusCode = Number(decoded.status);
        const status: FriendStatus =
          statusCode === iqlabs.contract.CONNECTION_STATUS_PENDING
            ? 'pending'
            : statusCode === iqlabs.contract.CONNECTION_STATUS_APPROVED
              ? 'approved'
              : 'blocked';

        const requester = Number(decoded.requester); // 0 = partyA, 1 = partyB
        const blocker = Number(decoded.blocker); // 0 / 1 / 255

        const dmSeed = iqlabs.utils.deriveDmSeed(partyA, partyB);
        const dmSeedHex = Buffer.from(dmSeed).toString('hex');

        friendsList.push({
          address: partyA === ownerBase58 ? partyB : partyA,
          status,
          requester,
          blocker,
          dmSeed,
          dmSeedHex,
          tableAddress: pdaStr,
          partyA,
          partyB,
          dbRootId,
          lastTimestamp: lastTs,
        });
      }

      friendsList.sort(
        (a, b) => Number(b.lastTimestamp ?? 0) - Number(a.lastTimestamp ?? 0)
      );

      setFriends(friendsList);
    } catch (err) {
      console.error('[useFriends] Error:', err);
      const errorMsg = err instanceof Error ? err.message : 'Failed to load friends';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  }, [userAddress, readConnection, programId, accountCoder]);

  useEffect(() => {
    fetchFriends();
  }, [fetchFriends]);

  return {
    friends,
    loading,
    error,
    refetch: fetchFriends,
  };
}
