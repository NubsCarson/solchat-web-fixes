/**
 * Account Subscription Hook with Signature Tracking
 * - Based on CLI example pattern from iqlabs-sdk-cli-example
 * - Tracks seen signatures to avoid processing duplicates
 * - Fetches new transaction signatures when account changes
 * - More efficient than re-fetching all messages
 */

import { useEffect, useRef } from 'react';
import { PublicKey, type Connection } from '@solana/web3.js';
import { updateAccountCache, getCachedSignatures, invalidateSignatureCache } from '@/lib/rpc/cache';

export interface UseAccountSubscriptionParams {
  /**
   * Solana connection instance
   */
  connection: Connection;

  /**
   * Account to subscribe to (e.g., table address)
   */
  account: PublicKey | null;

  /**
   * Handler called with new signatures when account changes
   * Receives array of new signatures in chronological order (oldest first)
   */
  onNewSignatures: (signatures: string[]) => void | Promise<void>;

  /**
   * Commitment level for the subscription
   */
  commitment?: 'processed' | 'confirmed' | 'finalized';

  /**
   * Whether the subscription is enabled
   */
  enabled?: boolean;

  /**
   * Number of recent signatures to fetch on each change
   */
  fetchLimit?: number;

  /**
   * Component name for logging
   */
  logPrefix?: string;
}

/**
 * Subscribe to account changes and track new transaction signatures
 *
 * Based on CLI example's subscribeToAccount pattern:
 * - Maintains a Set of seen signatures
 * - On account change, fetches recent transactions
 * - Filters out already-seen signatures
 * - Calls handler with only new signatures
 *
 * This is more efficient than re-fetching all messages when using
 * signature-targeted decoding.
 */
export function useAccountSubscription({
  connection,
  account,
  onNewSignatures,
  commitment = 'confirmed',
  enabled = true,
  fetchLimit = 10,
  logPrefix = 'AccountSub',
}: UseAccountSubscriptionParams) {
  const subscriptionRef = useRef<number | null>(null);
  const seenSignaturesRef = useRef<Set<string>>(new Set());
  const handlerRef = useRef(onNewSignatures);
  const accountKey = account?.toBase58() ?? null;
  const lastFetchRef = useRef<number>(0);
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const markSignatureSeen = (signature: string) => {
    seenSignaturesRef.current.add(signature);
  };

  // Update handler ref when it changes
  useEffect(() => {
    handlerRef.current = onNewSignatures;
  }, [onNewSignatures]);

  useEffect(() => {
    const seen=seenSignaturesRef.current;
    if (!enabled || !account || !accountKey) {
      seen.clear();
      return;
    }

    let subscriptionId: number | null = null;
    let isActive = true;
    let revision = 0;
    let inFlight = false;
    let failures = 0;
    let initialPending = true;

    const fetchLatestSignatures = async (limit: number): Promise<string[]> => {
      const infos = await getCachedSignatures(connection, account, limit);
      return infos.map((info) => info.signature).filter(Boolean);
    };

    const schedule = () => {
      if (fetchTimeoutRef.current || !isActive) return;
      const wait = Math.max(150, 1000 - (Date.now() - lastFetchRef.current));
      fetchTimeoutRef.current = setTimeout(async () => {
        fetchTimeoutRef.current = null;
        if (!isActive || inFlight || initialPending) { if (isActive) schedule(); return; }
        const started = revision;
        inFlight = true;
        lastFetchRef.current = Date.now();
        try {
          invalidateSignatureCache(accountKey);
          const signatures = await fetchLatestSignatures(fetchLimit);
          if (!isActive) return;
          const fresh = signatures.filter(sig => !seen.has(sig)).reverse();
          if (fresh.length) {
            await handlerRef.current(fresh);
            if (!isActive) return;
            failures = 0;
            for (const sig of fresh) seen.add(sig);
            while (seen.size > 1000) seen.delete(seen.values().next().value!);
          }
        } catch (error) {
          console.error(`[${logPrefix}] Failed to process account change:`, error);
          if (++failures < 3) revision++;
        } finally {
          inFlight = false;
          if (revision !== started) schedule();
        }
      }, wait);
    };

    const subscribe = async () => {
      try {
        // Subscribe first: writes during the initial snapshot must trigger a
        // trailing read rather than disappearing into the baseline cache.
        subscriptionId = connection.onAccountChange(account, info => {
          if (!isActive) return;
          updateAccountCache(accountKey, info);
          invalidateSignatureCache(accountKey);
          revision++;
          schedule();
        }, commitment);
        subscriptionRef.current = subscriptionId;
        const initialRevision = revision;
        const initial = await fetchLatestSignatures(fetchLimit);
        initialPending = false;
        if (!isActive) return;
        if (revision === initialRevision) {
          for (const sig of initial) seen.add(sig);
        } else {
          schedule();
        }
      } catch (error) {
        initialPending = false;
        console.warn(`[${logPrefix}] Failed to subscribe:`, error);
      }
    };

    subscribe();

    return () => {
      isActive = false;
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
        fetchTimeoutRef.current = null;
      }
      if (subscriptionId !== null) {
        console.log(`[${logPrefix}] Unsubscribing from ${accountKey.slice(0, 8)}... (id: ${subscriptionId})`);
        connection.removeAccountChangeListener(subscriptionId).catch(() => undefined);
        subscriptionRef.current = null;
      }
      seen.clear();
    };
  }, [connection, account, accountKey, commitment, enabled, fetchLimit, logPrefix]);

  return { markSignatureSeen };
}
