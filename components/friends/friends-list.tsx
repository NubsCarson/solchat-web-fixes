/**
 * FriendsList Component
 * - Main friends list UI with tabs and actions
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey, type Signer } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { useRouter } from 'next/navigation';
import { useAppConnection, useAppWallet } from '@/lib/wallet/use-app-wallet';
import { useFriends } from '@/lib/friends/use-friends';
import { FriendsListView } from './friends-list-view';
import { DmChatModal } from './dm-chat-modal';
import { AddFriendModal } from './add-friend-modal';
import { BlockConfirmModal } from './block-confirm-modal';
import iqlabs from 'iqlabs-sdk';
import { IQ_IDL } from 'iqlabs-sdk/contract';
import type { SignerInput } from 'iqlabs-sdk/utils';
import { lookupEncryptionKey } from '@/lib/crypto/encryption-key';
import { sendTx } from '@/lib/iqlabs/send-tx';
import { requestDmConnection } from '@/lib/friends/request-connection';
import { DM_STATUS } from '@/lib/friends/types';
import type { Friend } from '@/lib/friends/types';
import { useFriendAlerts } from '@/lib/friends/use-friend-alerts';
import { GlobalStyles } from './theme';
import { ROOT_ID_BYTES } from '@/lib/iqlabs/constants';
import { notifyGateway } from '@/lib/gateway/reader';
import { usePendingMessages } from '@/lib/shared/use-pending-messages';
import { useMessageChannel } from '@/lib/shared/use-message-channel';
import { useAccountSubscription } from '@/lib/shared/use-account-subscription';
import { makeDmTimestampKey, setLastMessageTimestamp } from '@/lib/cache/message-timestamp-cache';
import { RpcConfigPrompt } from '@/components/ui/rpc-config-prompt';
import { runWithRpcRateLimit } from '@/lib/utils/rpc-request-queue';
import { useUserInit } from '@/lib/iqlabs/use-user-init';
import { makeDmChannelKey, dmChannelKeyToSeed } from '@/lib/shared/channel-utils';
import { extractErrorLogs } from '@/lib/utils/error-utils';
import { createDmFetcher } from '@/lib/friends/dm-fetcher';
import { useScrollTracker } from '@/lib/shared/use-scroll-tracker';
import { useDmKeys } from '@/lib/crypto/use-dm-keys';
import { encryptDmPayload } from '@/lib/crypto/dm-encryption';
type Tab = 'all' | 'pending' | 'blocked';

type FriendsListProps = {
    dmQueryAddress?: string;
};

export function FriendsList(props: FriendsListProps) {
    const wallet = useAppWallet();
    // A wallet change must discard decrypted messages, drafts and subscriptions.
    return <WalletFriendsList key={wallet.publicKey?.toBase58() ?? 'disconnected'} {...props} />;
}

function WalletFriendsList({ dmQueryAddress }: FriendsListProps) {
    /* --------------------------------------------------------------------------
     * Context & External Hooks
     * -------------------------------------------------------------------------- */
    const { connection, readConnection, endpointSource, setCustomRpcEndpoint } = useAppConnection();
    const wallet = useAppWallet();
    const router = useRouter();
    const userAddress = wallet?.publicKey?.toBase58() ?? null;
    const {
        isInitialized: isUserInitialized,
        error: userInitError,
    } = useUserInit();
    const programId = useMemo(() => iqlabs.contract.PROGRAM_ID, []);
    const dbRootId = useMemo(() => ROOT_ID_BYTES, []);
    const dbRoot = useMemo(
        () => iqlabs.contract.getDbRootPda(dbRootId),
        [dbRootId]
    );
    const builder = useMemo(
        () => iqlabs.contract.createInstructionBuilder(IQ_IDL, programId),
        [programId]
    );
    const { friends, loading, error: friendsError, refetch } = useFriends({
        userAddress: userAddress || '',
        readConnection,
    });
    const dmKeys = useDmKeys();

    useEffect(() => {
        if (!wallet.connected) return;
        dmKeys.deriveKeys();
    }, [wallet.connected, dmKeys.deriveKeys]);

    /* --------------------------------------------------------------------------
     * Local State
     * -------------------------------------------------------------------------- */
    // Friend list state
    const [activeTab, setActiveTab] = useState<Tab>('all');
    const [error, setError] = useState<string | null>(null);

    // DM state
    const [chatFriend, setChatFriend] = useState<Friend | null>(null);
    const [chatOpen, setChatOpen] = useState(false);
    const markDmSignatureSeenRef = useRef<(signature: string) => void>(() => {});
    const chatPendingState = usePendingMessages();
    const {
        pendingMessages: chatPendingMessages,
        pruneConfirmedMessages: pruneChatPendingMessages,
        removePendingMessage: removeChatPendingMessage,
        resetPendingMessages: resetChatPendingMessages,
    } = chatPendingState;
    const [chatActionError, setChatActionError] = useState<string | null>(null);
    const [chatMessageInput, setChatMessageInput] = useState('');

    // Attachment state
    const [showAttachmentInput, setShowAttachmentInput] = useState(false);
    const [attachmentUrl, setAttachmentUrl] = useState('');
    const [attachmentError, setAttachmentError] = useState<string | null>(null);
    const [dmNotificationsEnabled, setDmNotificationsEnabled] = useState(true);
    const DM_RATE_LIMIT = 3;
    const [chatSlowRpcMode, setChatSlowRpcMode] = useState(endpointSource === 'default');
    const [dmHasNewMessages, setDmHasNewMessages] = useState(false);
    const [dmNewMarkerId, setDmNewMarkerId] = useState<string | null>(null);
    const [dmUiIsAtBottom, setDmUiIsAtBottom] = useState(true);
    const dmMarkerByChannelRef = useRef<Record<string, string | null>>({});
    const prevDmCountRef = useRef<number>(0);
    const dmInitialScrollRef = useRef<boolean>(false);

    // Modal/UI state
    const [addFriendModalOpen, setAddFriendModalOpen] = useState(false);
    const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);
    const [friendToBlock, setFriendToBlock] = useState<Friend | null>(null);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

    // Refs
    const chatMessagesEndRef = useRef<HTMLDivElement>(null);
    const chatListRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<HTMLInputElement>(null);
    const dmIsAtBottomRef = useRef(true);
    const dmMarkerElRef = useRef<HTMLDivElement | null>(null);
    const dmMarkerClearTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const signer = useMemo<SignerInput | null>(() => {
        if (!wallet?.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
            return null;
        }
        return {
            publicKey: wallet.publicKey,
            signTransaction: wallet.signTransaction.bind(wallet),
            signAllTransactions: wallet.signAllTransactions.bind(wallet),
        };
    }, [wallet]);
    const hasWallet = Boolean(wallet?.publicKey);

    const [encStatus, setEncStatus] = useState<'deriving' | 'ready' | 'off'>('off');
    const encError: string | null = null;

    useEffect(() => {
        if (!wallet.connected) {
            setEncStatus('off');
        } else if (dmKeys.ready) {
            setEncStatus('ready');
        } else {
            setEncStatus('deriving');
        }
    }, [wallet.connected, dmKeys.ready]);

    /* --------------------------------------------------------------------------
     * Derived Values
     * -------------------------------------------------------------------------- */
    const isRequesterForFriend = useCallback(
        (friend: Friend) => {
            if (!userAddress) return false;
            if (friend.requester === 0 && friend.partyA === userAddress) return true;
            if (friend.requester === 1 && friend.partyB === userAddress) return true;
            return false;
        },
        [userAddress]
    );

    const canSendChatToFriend = useCallback(
        (friend: Friend) => {
            if (!userAddress) return false;
            if (friend.status === 'approved') return true;
            if (friend.status === 'pending') {
                return isRequesterForFriend(friend);
            }
            return false;
        },
        [isRequesterForFriend, userAddress]
    );

    // Filter friends by tab
    const friendMapBySeedHex = useMemo(() => {
        const map: Record<string, Friend> = {};
        friends.forEach((friend) => {
            if (friend.dmSeedHex) {
                map[friend.dmSeedHex] = friend;
            }
        });
        return map;
    }, [friends]);

    const selectedDmChannelKey = useMemo(
        () => (chatFriend?.dmSeedHex ? makeDmChannelKey(chatFriend.dmSeedHex) : null),
        [chatFriend?.dmSeedHex]
    );

    const {
        friendTimestamps,
        setFriendTimestamps,
        toastMessage,
    } = useFriendAlerts({
        friends,
        chatOpen,
        activeChatSeedHex: chatFriend?.dmSeedHex ?? null,
    });

    const setDmMarker = useCallback((channelKey: string, markerId: string | null) => {
        dmMarkerByChannelRef.current[channelKey] = markerId;
        if (selectedDmChannelKey === channelKey) {
            setDmNewMarkerId(markerId);
            setDmHasNewMessages(Boolean(markerId));
        }
    }, [selectedDmChannelKey]);

    const clearDmMarker = useCallback((channelKey: string | null) => {
        if (!channelKey) return;
        setDmMarker(channelKey, null);
    }, [setDmMarker]);

    useEffect(() => {
        setChatSlowRpcMode(endpointSource === 'default');
    }, [endpointSource]);

    const enrichedFriends = useMemo(() => {
        return friends.map((friend) => ({
            ...friend,
            lastTimestamp: friendTimestamps[friend.dmSeedHex] ?? friend.lastTimestamp ?? 0,
        }));
    }, [friends, friendTimestamps]);

    const filteredFriends = useMemo(() => {
        let list: Friend[] = [];
        if (activeTab === 'all') {
            list = enrichedFriends.filter((f) => f.status === 'approved');
        } else if (activeTab === 'pending') {
            list = enrichedFriends.filter((f) => f.status === 'pending');
        } else if (activeTab === 'blocked') {
            list = enrichedFriends.filter((f) => f.status === 'blocked');
        } else {
            list = enrichedFriends;
        }
        return [...list].sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
    }, [enrichedFriends, activeTab]);

    useEffect(() => {
        resetChatPendingMessages();
    }, [chatFriend?.dmSeedHex, resetChatPendingMessages]);

    const { updateIsAtBottom: updateDmIsAtBottom } = useScrollTracker({
        listRef: chatListRef,
        isAtBottomRef: dmIsAtBottomRef,
        setUiIsAtBottom: setDmUiIsAtBottom,
        selectedChannelKey: selectedDmChannelKey,
        clearMarker: clearDmMarker,
        markerClearTimeoutRef: dmMarkerClearTimeoutRef,
        markerElRef: dmMarkerElRef,
    });

    /* --------------------------------------------------------------------------
     * Data Loading Helpers (DM)
     * -------------------------------------------------------------------------- */
    const resolveChannelMeta = useCallback((channelKey: string) => {
        const seedHex = dmChannelKeyToSeed(channelKey);
        const friend = friendMapBySeedHex[seedHex];
        if (!friend) return null;
        return {
            channelKey,
            seedHex,
            tableAddress: friend.tableAddress,
        };
    }, [friendMapBySeedHex]);

    const fetcher = useMemo(
        () =>
            createDmFetcher({
                userAddress,
                endpointSource,
                friendMapBySeedHex,
                setChatSlowRpcMode,
                signMessage: wallet.signMessage,
            }),
        [userAddress, endpointSource, friendMapBySeedHex, setChatSlowRpcMode, wallet.signMessage]
    );

    const {
        messages: dmMessages,
        messagesLoading: chatLoading,
        messagesError: chatLoaderError,
        showLoadingSpinner: showChatLoadingSpinner,
        triggerLiveLatest,
        targetedDecode,
        applyLocalRows,
        resetChannelState,
        lastInsertModeRef,
        mergedMessages: orderedChatMessages,
        sendMessage: handleSendChatMessage,
    } = useMessageChannel({
        reader: {
            channelKey: selectedDmChannelKey,
            resolveChannelMeta,
            fetcher,
            connection: readConnection,
            endpointSource,
            roomRateLimit: DM_RATE_LIMIT,
            onRowsApplied: ({ seedHex, rows }) => {
                const latestTimestamp = rows.reduce((max, msg) => Math.max(max, msg.timestamp ?? 0), 0);
                if (latestTimestamp) {
                    setLastMessageTimestamp(makeDmTimestampKey(seedHex), latestTimestamp);
                    setFriendTimestamps((prev) => ({ ...prev, [seedHex]: latestTimestamp }));
                }
            },
            runWithRpcRateLimit,
        },
        pending: chatPendingState,
        sender: {
            messageInput: chatMessageInput,
            attachmentUrl,
            setMessageInput: setChatMessageInput,
            setAttachmentUrl,
            setAttachmentError,
            setShowAttachmentInput,
            setActionError: setChatActionError,
            getSender: () => userAddress ?? '',
            getMessageId: () =>
                typeof crypto !== 'undefined' && crypto.randomUUID
                    ? crypto.randomUUID().slice(0, 12)
                    : Math.random().toString(36).slice(2, 10),
            canSend: () => {
                if (!chatFriend || !signer || !userAddress) {
                    return { ok: false };
                }
                if (!canSendChatToFriend(chatFriend)) {
                    return { ok: false, errorMessage: 'Approve the request to continue this conversation.' };
                }
                return { ok: true };
            },
            writeMessage: async (payload) => {
                const recipientAddress = chatFriend!.address;
                const recipientPubKey = await lookupEncryptionKey(readConnection, recipientAddress);
                const plainText = typeof payload.text === 'string' ? payload.text : '';
                // Match the CLI row layout: row metadata (id, sender, timestamp)
                // stays in clear on the row and only the message body is encrypted
                // into `text`. Decryption yields plain text, not wrapped JSON.
                const body = await encryptDmPayload(dmKeys.pubHex ?? '', recipientPubKey ?? '', plainText);
                const row = {
                    id: payload.id,
                    text: body,
                    sender: payload.sender,
                    timestamp: payload.timestamp,
                    ...(payload.file ? { file: payload.file } : {}),
                    enc: 1,
                };
                return iqlabs.writer.writeConnectionRow(
                    connection,
                    signer! as Signer,
                    dbRootId,
                    chatFriend!.dmSeed,
                    JSON.stringify(row)
                );
            },
            onBeforeSend: (_payload, timestamp) => {
                if (chatFriend?.dmSeedHex) {
                    const dmKey = chatFriend.dmSeedHex;
                    setLastMessageTimestamp(makeDmTimestampKey(dmKey), timestamp);
                    setFriendTimestamps((prev) => ({ ...prev, [dmKey]: timestamp }));
                }
            },
            onAfterSuccess: (payload, signature) => {
                if (chatFriend?.dmSeedHex) {
                    if (signature) markDmSignatureSeenRef.current(signature);
                    if (chatFriend.tableAddress && signature) notifyGateway(chatFriend.tableAddress, signature, userAddress ?? undefined);
                    const channelKey = makeDmChannelKey(chatFriend.dmSeedHex);
                    applyLocalRows(channelKey, [
                        {
                            ...payload,
                            status: 'confirmed',
                            signature,
                            room: chatFriend.dmSeedHex,
                        },
                    ]);
                    removeChatPendingMessage(payload.id);
                }
            },
            onAfterError: (err, payload) => {
                removeChatPendingMessage(payload.id);
                let message = err instanceof Error ? err.message : 'Failed to send DM';
                if (message.includes('connection table not found')) {
                    message = 'Friend request not yet approved by the other user, or the connection does not exist on-chain yet.';
                }
                setChatActionError(message);
            },
        },
    });

    useEffect(() => {
        if (!selectedDmChannelKey) {
            setDmNewMarkerId(null);
            setDmHasNewMessages(false);
            return;
        }
        setDmNewMarkerId(dmMarkerByChannelRef.current[selectedDmChannelKey] ?? null);
        setDmHasNewMessages(Boolean(dmMarkerByChannelRef.current[selectedDmChannelKey]));
    }, [selectedDmChannelKey]);

    useEffect(() => {
        if (!selectedDmChannelKey) return;
        const current = dmMessages.length;
        const prev = prevDmCountRef.current;
        const mode = lastInsertModeRef.current[selectedDmChannelKey] ?? null;
        if (mode === 'prepend') {
            lastInsertModeRef.current[selectedDmChannelKey] = null;
            prevDmCountRef.current = current;
            return;
        }
        if (current > prev && !dmIsAtBottomRef.current && mode !== 'append') {
            const latest = dmMessages[dmMessages.length - 1];
            const latestSender = latest?.sender;
            const viewer = userAddress;
            const isOwn = viewer && latestSender && viewer === latestSender;
            if (latest?.id && !dmMarkerByChannelRef.current[selectedDmChannelKey] && !isOwn) {
                setDmMarker(selectedDmChannelKey, latest.id);
            }
            setDmHasNewMessages(true);
        }
        lastInsertModeRef.current[selectedDmChannelKey] = null;
        prevDmCountRef.current = current;
    }, [dmMessages, lastInsertModeRef, selectedDmChannelKey, setDmMarker, userAddress]);

    const chatError = chatActionError ?? chatLoaderError;

    const scrollChatToBottom = useCallback(() => {
        chatMessagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        setDmUiIsAtBottom(true);
    }, []);

    const loadChatHistory = useCallback(
        async (friend: Friend | null) => {
            if (!friend?.dmSeedHex) return;
            const channelKey = makeDmChannelKey(friend.dmSeedHex);
            await triggerLiveLatest(channelKey);
        },
        [triggerLiveLatest]
    );

    const handleOpenChat = useCallback(async (friend: Friend) => {
        setChatFriend(friend);
        setChatActionError(null);
        setChatMessageInput('');
        setChatOpen(true);
        // Prefetch recipient's encryption pubkey in the background so the first
        // message send doesn't have to wait for the (potentially slow) on-chain lookup.
        void lookupEncryptionKey(readConnection, friend.address);
        await loadChatHistory(friend);
        dmInitialScrollRef.current = true;
        setTimeout(() => {
            scrollChatToBottom();
        }, 0);
    }, [loadChatHistory, scrollChatToBottom, readConnection]);

    const handleDmNewSignatures = useCallback(async (signatures: string[]) => {
        if (!chatFriend?.dmSeedHex) return;
        const channelKey = makeDmChannelKey(chatFriend.dmSeedHex);
        for (const signature of signatures) {
            try {
                await targetedDecode(channelKey, signature);
            } catch (error) {
                console.error('[FriendsList] Failed to decode DM signature', signature.slice(0, 8), error);
            }
        }
    }, [chatFriend?.dmSeedHex, targetedDecode]);

    /* --------------------------------------------------------------------------
     * Effects
     * -------------------------------------------------------------------------- */
    useEffect(() => {
        if (!dmQueryAddress) return;
        const friend = friends.find((f) => f.address === dmQueryAddress);
        if (!friend) return;

        void handleOpenChat(friend);
        router.replace('/friends', { scroll: false });
    }, [dmQueryAddress, friends, handleOpenChat, router]);

    useEffect(() => {
        if (chatOpen && (dmIsAtBottomRef.current || dmInitialScrollRef.current)) {
            scrollChatToBottom();
            dmIsAtBottomRef.current = true;
            dmInitialScrollRef.current = false;
        }
        updateDmIsAtBottom();
        const el = chatListRef.current;
        if (!el) return;
        el.addEventListener('scroll', updateDmIsAtBottom, { passive: true });
        return () => {
            el.removeEventListener('scroll', updateDmIsAtBottom);
        };
    }, [orderedChatMessages, chatPendingMessages, chatOpen, scrollChatToBottom, updateDmIsAtBottom]);

    useEffect(() => {
        if (!chatPendingMessages.length) return;
        pruneChatPendingMessages(dmMessages);
    }, [dmMessages, chatPendingMessages.length, pruneChatPendingMessages]);

    const chatFriendTableAccount = useMemo(() => {
        if (!chatFriend?.tableAddress) return null;
        try {
            return new PublicKey(chatFriend.tableAddress);
        } catch (error) {
            console.warn('[FriendsList] Invalid chat table address:', error);
            return null;
        }
    }, [chatFriend?.tableAddress]);

    const { markSignatureSeen: markDmSignatureSeen } = useAccountSubscription({
        connection: readConnection,
        account: chatFriendTableAccount,
        onNewSignatures: handleDmNewSignatures,
        commitment: 'confirmed',
        enabled: typeof document === 'undefined' || document.visibilityState === 'visible',
        fetchLimit: 10,
        logPrefix: 'FriendsList DM',
    });
    markDmSignatureSeenRef.current = markDmSignatureSeen;

    /* --------------------------------------------------------------------------
     * Event Handlers
     * -------------------------------------------------------------------------- */
    const handleAddFriend = async (friendAddress: string) => {
        setError(null);
        if (!userAddress || !wallet || !signer) {
            throw new Error('Wallet not connected');
        }

        if (friendAddress === userAddress) {
            throw new Error('Cannot add yourself as a friend');
        }
        console.log('[FriendsList] Sending friend request to:', friendAddress);

        const existing = friends.find((f) => f.address === friendAddress);
        if (existing) {
            if (existing.status === 'approved') {
                throw new Error('You are already friends with this user');
            } else if (existing.status === 'pending') {
                throw new Error('Friend request already pending');
            } else if (existing.status === 'blocked') {
                throw new Error('This user is blocked. Unblock them first');
            }
        }

        if (!isUserInitialized) {
            throw new Error('Account not fully initialized. Please wait for setup to complete.');
        }

        try {
            await requestDmConnection(connection, signer, ROOT_ID_BYTES, signer.publicKey.toBase58(), friendAddress.trim());
            await refetch();
            setAddFriendModalOpen(false);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to send request';
            setError(message);

            const maybeLogs = extractErrorLogs(err);
            if (maybeLogs) {
                console.error('[FriendsList] requestConnection logs', maybeLogs);
            }
            console.error('[FriendsList] requestConnection error', err);

            throw err;
        }
    };

    const handleApproveFriend = async (friend: Friend) => {
        if (!wallet || !signer) throw new Error('Wallet not connected');

        console.log('[FriendsList] Approving friend:', {
            friendAddress: friend.address,
            dmSeedHex: friend.dmSeedHex,
            tableAddress: friend.tableAddress,
            partyA: friend.partyA,
            partyB: friend.partyB,
        });

        setError(null);

        try {
            const connectionTable = iqlabs.contract.getConnectionTablePda(
                dbRoot,
                friend.dmSeed
            );
            const ix = iqlabs.contract.manageConnectionInstruction(
                builder,
                {
                    db_root: dbRoot,
                    connection_table: connectionTable,
                    signer: signer.publicKey,
                },
                {
                    db_root_id: dbRootId,
                    connection_seed: Buffer.from(friend.dmSeed),
                    new_status: DM_STATUS.APPROVED,
                }
            );
            await sendTx(connection, signer, ix);
            await refetch();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to approve friend';
            setError(message);
            console.error('[FriendsList] Failed to approve friend', err);
        }
    };

    const showBlockConfirm = (friend: Friend) => {
        setFriendToBlock(friend);
        setBlockConfirmOpen(true);
    };

    const handleBlockFriend = async () => {
        if (!signer || !friendToBlock) return;

        setError(null);
        setBlockConfirmOpen(false);

        try {
            const connectionTable = iqlabs.contract.getConnectionTablePda(
                dbRoot,
                friendToBlock.dmSeed
            );
            const ix = iqlabs.contract.manageConnectionInstruction(
                builder,
                {
                    db_root: dbRoot,
                    connection_table: connectionTable,
                    signer: signer.publicKey,
                },
                {
                    db_root_id: dbRootId,
                    connection_seed: Buffer.from(friendToBlock.dmSeed),
                    new_status: DM_STATUS.BLOCKED,
                }
            );
            await sendTx(connection, signer, ix);
            await refetch();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to block friend';
            setError(message);
            console.error('[FriendsList] Failed to block friend', err);
        } finally {
            setFriendToBlock(null);
        }
    };

    const handleUnblockFriend = async (friend: Friend) => {
        if (!signer) throw new Error('Wallet not connected');

        setError(null);

        try {
            const connectionTable = iqlabs.contract.getConnectionTablePda(
                dbRoot,
                friend.dmSeed
            );
            const ix = iqlabs.contract.manageConnectionInstruction(
                builder,
                {
                    db_root: dbRoot,
                    connection_table: connectionTable,
                    signer: signer.publicKey,
                },
                {
                    db_root_id: dbRootId,
                    connection_seed: Buffer.from(friend.dmSeed),
                    new_status: DM_STATUS.APPROVED,
                }
            );
            await sendTx(connection, signer, ix);
            await refetch();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to unblock friend';
            setError(message);
            console.error('[FriendsList] Failed to unblock friend', err);
        }
    };

    const closeChatModal = () => {
        setChatOpen(false);
        setChatFriend(null);
        resetChannelState(null, { resetMessages: true });
        resetChatPendingMessages();
        setChatActionError(null);
        setChatMessageInput('');
        setAttachmentUrl('');
        setAttachmentError(null);
        setShowAttachmentInput(false);
        setDmHasNewMessages(false);
        setDmNewMarkerId(null);
    };

    const handleCopyAddress = useCallback((address: string, messageId: string) => {
        navigator.clipboard?.writeText(address);
        setCopiedMessageId(messageId);
        setTimeout(() => setCopiedMessageId(null), 2000);
    }, []);

    const handleDownloadAttachment = useCallback((url: string) => {
        window.open(url, '_blank');
    }, []);

    const handleDmScrollToBottom = useCallback(() => {
        chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        dmIsAtBottomRef.current = true;
        setDmUiIsAtBottom(true);
        setDmHasNewMessages(false);
        clearDmMarker(selectedDmChannelKey);
    }, [clearDmMarker, selectedDmChannelKey]);

    const canWriteDm = !!signer && isUserInitialized && !!chatFriend && canSendChatToFriend(chatFriend);
    const canSubmitDm = !!signer && isUserInitialized && !!chatMessageInput.trim() && !!chatFriend && canSendChatToFriend(chatFriend);

    return (
        <div>
            <RpcConfigPrompt
                endpointSource={endpointSource}
                setCustomRpcEndpoint={setCustomRpcEndpoint}
            />
            <GlobalStyles />
            <div className="flex-1 p-4 md:p-6 max-w-4xl mx-auto w-full">
                <FriendsListView
                    error={error}
                    friendsError={friendsError}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    onOpenAddFriend={() => setAddFriendModalOpen(true)}
                    userAddress={userAddress}
                    loading={loading}
                    filteredFriends={filteredFriends}
                    onApprove={handleApproveFriend}
                    onBlock={showBlockConfirm}
                    onUnblock={handleUnblockFriend}
                    onOpenChat={handleOpenChat}
                />
            </div>
            <DmChatModal
                open={chatOpen}
                chatFriend={chatFriend}
                dmNotificationsEnabled={dmNotificationsEnabled}
                onToggleNotifications={() => setDmNotificationsEnabled((prev) => !prev)}
                onClose={closeChatModal}
                isRequesterForFriend={isRequesterForFriend}
                chatSlowRpcMode={chatSlowRpcMode}
                chatListRef={chatListRef}
                chatMessagesEndRef={chatMessagesEndRef}
                dmMarkerElRef={dmMarkerElRef}
                orderedChatMessages={orderedChatMessages}
                showChatLoadingSpinner={showChatLoadingSpinner}
                chatError={chatError}
                chatLoading={chatLoading}
                dmNewMarkerId={dmNewMarkerId}
                userAddress={userAddress}
                copiedMessageId={copiedMessageId}
                onCopyAddress={handleCopyAddress}
                onDownloadAttachment={handleDownloadAttachment}
                dmUiIsAtBottom={dmUiIsAtBottom}
                dmHasNewMessages={dmHasNewMessages}
                onScrollToBottomClick={handleDmScrollToBottom}
                chatMessageInput={chatMessageInput}
                setChatMessageInput={setChatMessageInput}
                attachmentUrl={attachmentUrl}
                setAttachmentUrl={setAttachmentUrl}
                showAttachmentInput={showAttachmentInput}
                setShowAttachmentInput={setShowAttachmentInput}
                attachmentError={attachmentError}
                setAttachmentError={setAttachmentError}
                onSubmitMessage={handleSendChatMessage}
                hasWallet={hasWallet}
                canWrite={canWriteDm}
                canSubmit={canSubmitDm}
                isUserInitialized={isUserInitialized}
                userInitError={userInitError}
                inputRef={chatInputRef}
                encStatus={encStatus}
                encError={encError}
            />

            <AddFriendModal
                open={addFriendModalOpen}
                onClose={() => setAddFriendModalOpen(false)}
                onSubmit={handleAddFriend}
                disabled={!userAddress}
            />

            <BlockConfirmModal
                open={blockConfirmOpen}
                friend={friendToBlock}
                onCancel={() => {
                    setBlockConfirmOpen(false);
                    setFriendToBlock(null);
                }}
                onConfirm={handleBlockFriend}
            />
            {toastMessage && (
                <div className="fixed bottom-4 right-4 z-50 rounded bg-black/80 px-4 py-2 text-xs text-amber-200 border border-amber-400/60 shadow-lg">
                    {toastMessage}
                </div>
            )}
        </div>
    );
}
