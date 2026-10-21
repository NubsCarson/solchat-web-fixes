import { test, expect, mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

let state;
mock.module('@/lib/voice/VoiceCallContext', () => ({
  useVoiceCallContext: () => state,
}));
const { ActiveCallBar } = await import('../components/voice/ActiveCallBar');
const { createRoot } = await import('react-dom/client');

async function setup({ remoteVideo = false, blocked = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const plays = [];
  let rejectPlayback = blocked;
  const originalPlay = dom.window.HTMLMediaElement.prototype.play;
  dom.window.HTMLMediaElement.prototype.play = function () {
    plays.push(this);
    return rejectPlayback
      ? Promise.reject(new Error('NotAllowedError'))
      : Promise.resolve();
  };
  const remoteStream = { getVideoTracks: () => remoteVideo ? [{ kind: 'video' }] : [] };
  const localStream = { getVideoTracks: () => [] };
  state = {
    status: 'active', remotePubkey: 'test-remote-wallet',
    isMuted: false, isVideoEnabled: false, isScreenSharing: false,
    webrtcState: 'connected', error: null, duration: 1,
    localStream, remoteStream,
    toggleMute() {}, toggleVideo() {}, toggleScreenShare() {}, endCall() {},
  };
  const root = createRoot(document.getElementById('root'));
  const render = async () => act(async () => root.render(<ActiveCallBar />));
  await render();
  return {
    plays, remoteStream, localStream, render,
    allowPlayback: () => { rejectPlayback = false; },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.HTMLMediaElement.prototype.play = originalPlay;
      dom.window.close();
    },
  };
}

test('an audio-only call mounts and plays its remote stream without a video overlay', async () => {
  const view = await setup();
  const audio = document.querySelector('audio');
  try {
    expect(audio).not.toBeNull();
    expect(audio.srcObject).toBe(view.remoteStream);
    expect(audio.muted).toBe(false);
    expect(view.plays).toEqual([audio]);
    expect(document.querySelector('video')).toBeNull();
    expect(document.body.textContent).toContain('CONNECTED');
  } finally { await view.close(); }
  expect(audio.srcObject).toBeNull();
});

test('video renders muted while the single audio sink owns remote playback', async () => {
  const view = await setup({ remoteVideo: true });
  try {
    const audio = document.querySelector('audio');
    const video = document.querySelector('video');
    expect(document.querySelectorAll('audio')).toHaveLength(1);
    expect(audio.srcObject).toBe(view.remoteStream);
    expect(video.srcObject).toBe(view.remoteStream);
    expect(video.muted).toBe(true);
    expect(view.plays).toEqual([audio]);
  } finally { await view.close(); }
});

test('enabling local video attaches the unchanged stream when its element mounts', async () => {
  const view = await setup();
  try {
    expect(document.querySelector('video')).toBeNull();
    state = { ...state, isVideoEnabled: true };
    await view.render();
    const videos = [...document.querySelectorAll('video')];
    expect(videos).toHaveLength(2);
    expect(videos[0].srcObject).toBe(view.remoteStream);
    expect(videos[1].srcObject).toBe(view.localStream);
    expect(videos.every((video) => video.muted)).toBe(true);
    expect(view.plays).toHaveLength(1);
  } finally { await view.close(); }
});

test('blocked autoplay presents an explicit retry and successful playback clears it', async () => {
  const view = await setup({ blocked: true });
  try {
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Play call audio');
    expect(retry).not.toBeUndefined();
    view.allowPlayback();
    await act(async () => retry.click());
    expect(document.body.textContent).not.toContain('Play call audio');
    expect(view.plays).toHaveLength(2);
    expect(view.plays.every((element) => element === document.querySelector('audio'))).toBe(true);
  } finally { await view.close(); }
});
