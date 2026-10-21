import { test, expect, beforeEach } from "bun:test";
import { WebRTCManager } from "../lib/voice/webrtc-manager";

class Track {
  kind;
  id = crypto.randomUUID();
  enabled = true;
  readyState = "live";
  onended = null;
  constructor(kind) {
    this.kind = kind;
  }
  stop() {
    this.readyState = "ended";
  }
}

class Stream {
  tracks;
  id = crypto.randomUUID();
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(track) {
    this.tracks.push(track);
  }
}

class Peer {
  static latest;
  senders = [];
  remoteDescription = null;
  closed = false;
  constructor() {
    Peer.latest = this;
  }
  addTrack(track) {
    const sender = {
      track,
      replaceTrack: async (next) => {
        sender.track = next;
      },
    };
    this.senders.push(sender);
    return sender;
  }
  addTransceiver(kind) {
    expect(kind).toBe("video");
    const sender = {
      track: null,
      replaceTrack: async (next) => {
        sender.track = next;
      },
    };
    this.senders.push(sender);
    return { sender };
  }
  close() {
    this.closed = true;
  }
  async createOffer() {
    return {
      type: "offer",
      sdp: `v=0\r
a=rtcp-fb:96 nack\r
`,
    };
  }
  async setLocalDescription(_value) {}
}
let requests = [];
let microphone, camera, screen;
let getMedia;
let getDisplay;
let screenEnded = 0;
let local = null;
beforeEach(() => {
  requests = [];
  microphone = new Track("audio");
  camera = new Track("video");
  screen = new Track("video");
  screenEnded = 0;
  local = null;
  getMedia = async (constraints) => {
    requests.push(constraints);
    return new Stream(
      constraints.audio
        ? [microphone, ...(constraints.video ? [camera] : [])]
        : [camera],
    );
  };
  getDisplay = async () => new Stream([screen]);
  Object.assign(globalThis, { MediaStream: Stream, RTCPeerConnection: Peer });
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: (c) => getMedia(c),
        getDisplayMedia: () => getDisplay(),
      },
    },
    configurable: true,
  });
});
function create() {
  return new WebRTCManager({
    onIceCandidates: () => {},
    onConnectionStateChange: () => {},
    onRemoteStream: () => {},
    onLocalStream: (s) => {
      local = s;
    },
    onScreenShareEnded: () => {
      screenEnded++;
    },
    onError: () => {},
  });
}
test("audio-only setup reserves a video sender without opening the camera", async () => {
  const manager = create();
  await manager.initialize(false);
  expect(requests).toEqual([{ audio: true, video: false }]);
  expect(Peer.latest.senders).toHaveLength(2);
  expect(Peer.latest.senders[1].track).toBeNull();
  await manager.setVideoEnabled(true);
  expect(Peer.latest.senders[1].track).toBe(camera);
  expect(requests[1]).toEqual({ audio: false, video: { facingMode: "user" } });
  expect(local.getVideoTracks()).toEqual([camera]);
  expect(await manager.createOffer()).toContain("a=rtcp-fb:96 nack");
  manager.cleanup();
});
test("screen sharing from an audio call preserves microphone, then returns to camera", async () => {
  const manager = create();
  await manager.initialize(false);
  await manager.setVideoEnabled(true);
  await manager.startScreenShare();
  expect(Peer.latest.senders[1].track).toBe(screen);
  expect(microphone.readyState).toBe("live");
  expect(Peer.latest.senders[0].track).toBe(microphone);
  await manager.stopScreenShare();
  expect(Peer.latest.senders[1].track).toBe(camera);
  expect(screen.readyState).toBe("ended");
  expect(screenEnded).toBe(1);
  manager.cleanup();
  expect(camera.readyState).toBe("ended");
  expect(microphone.readyState).toBe("ended");
  expect(Peer.latest.closed).toBe(true);
});
test("browser Stop Sharing restores the disabled-camera audio call", async () => {
  const manager = create();
  await manager.initialize(false);
  await manager.startScreenShare();
  screen.onended?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(Peer.latest.senders[1].track).toBeNull();
  expect(screenEnded).toBe(1);
  expect(microphone.readyState).toBe("live");
  manager.cleanup();
});
test("cancelled screen picker leaves the active voice call unchanged", async () => {
  const manager = create();
  await manager.initialize(false);
  getDisplay = async () => {
    throw new Error("NotAllowedError");
  };
  await expect(manager.startScreenShare()).rejects.toThrow("NotAllowedError");
  expect(Peer.latest.senders[1].track).toBeNull();
  expect(microphone.readyState).toBe("live");
  manager.cleanup();
});
test("media permission finishing after hangup stops every returned track", async () => {
  let resolve;
  getMedia = () =>
    new Promise((r) => {
      resolve = r;
    });
  const manager = create();
  const pending = manager.initialize(true);
  manager.cleanup();
  resolve(new Stream([microphone, camera]));
  await pending;
  expect(microphone.readyState).toBe("ended");
  expect(camera.readyState).toBe("ended");
  expect(local).toBeNull();
});
test("hangup while screen replacement is pending stops the new capture", async () => {
  const manager = create();
  await manager.initialize(false);
  let finish;
  Peer.latest.senders[1].replaceTrack = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = manager.startScreenShare();
  await Promise.resolve();
  manager.cleanup();
  finish();
  await expect(pending).rejects.toThrow("Call ended");
  expect(screen.readyState).toBe("ended");
});
test("concurrent camera requests share one capture and cleanup stops it", async () => {
  const manager = create();
  await manager.initialize(false);
  let finish;
  let count = 0;
  getMedia = () => {
    count++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = manager.setVideoEnabled(true);
  const second = manager.setVideoEnabled(true);
  expect(count).toBe(1);
  finish(new Stream([camera]));
  await Promise.all([first, second]);
  manager.cleanup();
  expect(camera.readyState).toBe("ended");
});


test("turning video off releases the camera and enabling it requests a fresh capture", async () => {
  const manager = create();
  await manager.initialize(true);
  const firstCamera = camera;
  await manager.setVideoEnabled(false);
  expect(firstCamera.readyState).toBe("ended");
  expect(Peer.latest.senders[1].track).toBeNull();
  expect(local.getVideoTracks()).toEqual([]);
  expect(microphone.readyState).toBe("live");
  camera = new Track("video");
  await manager.setVideoEnabled(true);
  expect(requests).toHaveLength(2);
  expect(Peer.latest.senders[1].track).toBe(camera);
  expect(camera).not.toBe(firstCamera);
  expect(camera.readyState).toBe("live");
  expect(local.getVideoTracks()).toEqual([camera]);
  manager.cleanup();
});

test("turning camera off during screen sharing preserves the screen and restores no camera", async () => {
  const manager = create();
  await manager.initialize(true);
  await manager.startScreenShare();
  await manager.setVideoEnabled(false);
  expect(camera.readyState).toBe("ended");
  expect(screen.readyState).toBe("live");
  expect(Peer.latest.senders[1].track).toBe(screen);
  expect(local.getVideoTracks()).toEqual([screen]);
  await manager.stopScreenShare();
  expect(Peer.latest.senders[1].track).toBeNull();
  expect(local.getVideoTracks()).toEqual([]);
  expect(screen.readyState).toBe("ended");
  expect(microphone.readyState).toBe("live");
  manager.cleanup();
});
