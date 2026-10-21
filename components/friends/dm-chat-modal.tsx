'use client';

import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';
import type { Friend } from '@/lib/friends/types';
import { shorten as shortenAddress } from '@/lib/utils/message-utils';
import type { MessageRow } from '@/lib/shared/message-helpers';
import { MessageBubble } from '@/components/ui/message-bubble';
import { MessageInputForm } from '@/components/chat/message-input-form';
import { NotificationToggle } from '@/components/ui/notification-toggle';
import { Button } from 'react95';
import {DMCallButton} from '@/components/voice/DMCallButton';

type DmChatModalProps = {
  open: boolean;
  chatFriend: Friend | null;
  dmNotificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onClose: () => void;
  isRequesterForFriend: (friend: Friend) => boolean;
  chatSlowRpcMode: boolean;
  chatListRef: RefObject<HTMLDivElement | null>;
  chatMessagesEndRef: RefObject<HTMLDivElement | null>;
  dmMarkerElRef: RefObject<HTMLDivElement | null>;
  orderedChatMessages: MessageRow[];
  showChatLoadingSpinner: boolean;
  chatError: string | null;
  chatLoading: boolean;
  dmNewMarkerId: string | null;
  userAddress: string | null;
  copiedMessageId: string | null;
  onCopyAddress: (address: string, messageId: string) => void;
  onDownloadAttachment: (url: string) => void;
  dmUiIsAtBottom: boolean;
  dmHasNewMessages: boolean;
  onScrollToBottomClick: () => void;
  chatMessageInput: string;
  setChatMessageInput: (value: string) => void;
  attachmentUrl: string;
  setAttachmentUrl: (value: string) => void;
  showAttachmentInput: boolean;
  setShowAttachmentInput: Dispatch<SetStateAction<boolean>>;
  attachmentError: string | null;
  setAttachmentError: (value: string | null) => void;
  onSubmitMessage: (event?: FormEvent) => void;
  hasWallet: boolean;
  canWrite: boolean;
  canSubmit: boolean;
  isUserInitialized: boolean;
  userInitError: Error | null;
  inputRef: RefObject<HTMLInputElement | null>;
  encStatus?: 'deriving' | 'publishing' | 'ready' | 'error' | 'off';
  encError?: string | null;
};

export function DmChatModal({
  open,
  chatFriend,
  dmNotificationsEnabled,
  onToggleNotifications,
  onClose,
  isRequesterForFriend,
  chatSlowRpcMode,
  chatListRef,
  chatMessagesEndRef,
  dmMarkerElRef,
  orderedChatMessages,
  showChatLoadingSpinner,
  chatError,
  chatLoading,
  dmNewMarkerId,
  userAddress,
  copiedMessageId,
  onCopyAddress,
  onDownloadAttachment,
  dmUiIsAtBottom,
  dmHasNewMessages,
  onScrollToBottomClick,
  chatMessageInput,
  setChatMessageInput,
  attachmentUrl,
  setAttachmentUrl,
  showAttachmentInput,
  setShowAttachmentInput,
  attachmentError,
  setAttachmentError,
  onSubmitMessage,
  hasWallet,
  canWrite,
  canSubmit,
  isUserInitialized,
  userInitError,
  inputRef,
  encStatus = 'off',
  encError,
}: DmChatModalProps) {
  if (!open || !chatFriend) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6">
      <div className="bg-black border-2 border-green-700 rounded-xl w-full max-w-4xl h-[85vh] flex flex-col">
        {/* Header */}
        <div className="border-b border-green-700/50 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <h3 className="text-green-400 font-bold">
            DM with {shortenAddress(chatFriend.address)}
          </h3>
          <div className="flex items-center gap-3">
            <DMCallButton targetPubkey={chatFriend.address} disabled={chatFriend.status !== "approved"} />
              <NotificationToggle
              enabled={dmNotificationsEnabled}
              onToggle={onToggleNotifications}
              label="NOTI"
              size="sm"
            />
            <Button onClick={onClose} size="sm" style={{ fontSize: '11px' }}>
              X
            </Button>
          </div>
        </div>

        {/* Info banner */}
        <div className="border-b border-green-700/30 bg-black/60 px-4 py-2 text-xs text-green-600 flex-shrink-0">
          <div className="mb-1">
            <span className="text-green-500">Table:</span> {shortenAddress(chatFriend.tableAddress)}
          </div>
          <div className="mb-1 break-all">
            <span className="text-green-500">Seed:</span> {chatFriend.dmSeedHex}
          </div>
          <div>
            <span className="text-green-500">Status:</span>{' '}
            <span className="uppercase">{chatFriend.status}</span>
            {chatFriend.status === 'pending' &&
              (isRequesterForFriend(chatFriend)
                ? ' (waiting for approval)'
                : ' (approve to reply)')}
            {chatFriend.status === 'blocked' && ' (unblock to continue)'}
          </div>
        </div>

        {/* Encryption status */}
        <div className={`border-b px-4 py-1.5 text-xs flex items-center gap-2 flex-shrink-0 ${
          encStatus === 'ready'
            ? 'border-green-700/30 bg-green-900/20 text-green-400'
            : encStatus === 'error'
              ? 'border-red-700/30 bg-red-900/20 text-red-400'
              : 'border-yellow-700/30 bg-yellow-900/20 text-yellow-400'
        }`}>
          {encStatus === 'ready' && (
            <>
              <span>&#128274;</span>
              <span>End-to-end encrypted</span>
            </>
          )}
          {encStatus === 'deriving' && (
            <>
              <span>&#128272;</span>
              <span>Deriving encryption keys...</span>
            </>
          )}
          {encStatus === 'publishing' && (
            <>
              <span>&#128272;</span>
              <span>Publishing encryption key on-chain...</span>
            </>
          )}
          {encStatus === 'error' && (
            <>
              <span>&#9888;</span>
              <span>Encryption setup failed{encError ? `: ${encError}` : ''}</span>
            </>
          )}
          {encStatus === 'off' && (
            <>
              <span>&#128275;</span>
              <span>Not encrypted — encryption keys not yet set up</span>
            </>
          )}
        </div>

        {chatSlowRpcMode && (
          <div className="border-b border-yellow-700/40 bg-yellow-900/20 px-4 py-2 text-xs text-amber-200 flex-shrink-0">
            Using public RPC — slow load mode (1 tx/sec). Messages will appear as they arrive.
          </div>
        )}

        {/* Messages */}
        <div className="relative flex-1 overflow-y-auto px-4 py-3 space-y-2 min-h-0" ref={chatListRef}>
          {showChatLoadingSpinner && orderedChatMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-8">
              <p className="text-green-400 text-sm mb-4">Loading messages...</p>
              <div style={{ width: '100%', maxWidth: '400px' }}>
                <div
                  style={{
                    height: '24px',
                    background: '#000000',
                    border: '2px solid #00ff00',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    position: 'relative',
                    boxShadow: '0 0 10px rgba(0, 255, 0, 0.3)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      height: '100%',
                      width: '25%',
                      background:
                        'linear-gradient(90deg, rgba(0, 255, 0, 0) 0%, rgba(0, 255, 0, 0.6) 50%, rgba(0, 255, 0, 0) 100%)',
                      animation: 'slide 2s linear infinite',
                      willChange: 'transform',
                    }}
                  ></div>
                </div>
              </div>
            </div>
          ) : chatError ? (
            <p className="text-red-400 text-sm">Error: {chatError}</p>
          ) : !chatLoading && orderedChatMessages.length === 0 && !chatError ? (
            <p className="text-green-600 text-sm">No messages yet. Start the conversation!</p>
          ) : null}
          {orderedChatMessages.map((message, index) => {
            const senderAddress = message.sender || userAddress || '';
            const displaySender = shortenAddress(senderAddress, 6);
            const key = message.id || `chat-row-${index}`;
            return (
              <div key={key} className="space-y-3">
                {dmNewMarkerId && message.id === dmNewMarkerId && (
                  <div className="flex items-center gap-2 text-xs text-emerald-200/80">
                    <div className="flex-1 h-px bg-emerald-500/40" />
                    <div
                      className="px-3 py-1 rounded-full bg-emerald-900/60 border border-emerald-500/50 shadow-[0_0_10px_rgba(16,185,129,0.35)]"
                      ref={dmMarkerElRef}
                    >
                      New messages
                    </div>
                    <div className="flex-1 h-px bg-emerald-500/40" />
                  </div>
                )}
                <MessageBubble
                  id={message.id || key}
                  text={message.text || ''}
                  sender={displaySender}
                  senderAddress={senderAddress}
                  displayName={message.displayName || displaySender}
                  timestamp={message.timestamp}
                  status={message.status}
                  signature={message.signature}
                  file={message.file}
                  isOwn={senderAddress === userAddress}
                  viewerAddress={userAddress || ''}
                  mode="friend"
                  onCopyAddress={onCopyAddress}
                  onDownloadAttachment={onDownloadAttachment}
                  copiedMessageId={copiedMessageId}
                />
              </div>
            );
          })}
          <div ref={chatMessagesEndRef} />
        </div>
        {!dmUiIsAtBottom && orderedChatMessages.length > 0 && (
          <button
            type="button"
            onClick={onScrollToBottomClick}
            className={`absolute bottom-24 right-6 z-10 flex items-center justify-center rounded-full text-black shadow-lg w-10 h-10 ${
              dmHasNewMessages ? 'bg-red-500 hover:bg-red-400' : 'bg-emerald-500 hover:bg-emerald-400'
            }`}
          >
            <span className="text-2xl leading-none font-black">▼</span>
          </button>
        )}

        {/* Input form */}
        <div className="rounded-b-xl overflow-hidden">
          <MessageInputForm
            messageInput={chatMessageInput}
            setMessageInput={setChatMessageInput}
            attachmentUrl={attachmentUrl}
            setAttachmentUrl={setAttachmentUrl}
            showAttachmentInput={showAttachmentInput}
            setShowAttachmentInput={setShowAttachmentInput}
            attachmentError={attachmentError}
            setAttachmentError={setAttachmentError}
            onSubmit={onSubmitMessage}
            hasWallet={hasWallet}
            canWrite={canWrite}
            canSubmit={canSubmit}
            isUserInitialized={isUserInitialized}
            userInitError={userInitError}
            inputRef={inputRef}
          />
        </div>
      </div>
    </div>
  );
}
