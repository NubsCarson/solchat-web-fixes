import { ICE_SERVERS } from "./types";

// Media stays peer-to-peer. Reserve video during audio setup so adding a camera
// or sharing a screen needs replaceTrack, not another on-chain negotiation.
export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream = new MediaStream();
  private camera: MediaStreamTrack | null = null;
  private screenStream: MediaStream | null = null;
  private videoSender: RTCRtpSender | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private candidates: RTCIceCandidate[] = [];
  private disposed = false;
  private cameraRequest: Promise<MediaStream> | null = null;

  constructor(
    private config: {
      onIceCandidates: (candidates: RTCIceCandidate[]) => void;
      onConnectionStateChange: (state: RTCPeerConnectionState) => void;
      onRemoteStream: (stream: MediaStream) => void;
      onLocalStream: (stream: MediaStream) => void;
      onScreenShareEnded: () => void;
      onError: (error: string) => void;
    },
  ) {}

  async initialize(video = false): Promise<void> {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.candidates.push(event.candidate);
    };
    this.pc.onicegatheringstatechange = () => {
      if (this.pc?.iceGatheringState === "complete")
        this.flushIceCandidatesNow();
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc) this.config.onConnectionStateChange(this.pc.connectionState);
    };
    this.pc.ontrack = (event) => {
      if (
        !this.remoteStream
          .getTracks()
          .some((track) => track.id === event.track.id)
      ) {
        this.remoteStream.addTrack(event.track);
      }
      this.config.onRemoteStream(
        new MediaStream(this.remoteStream.getTracks()),
      );
    };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: "user" } : false,
    });
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.localStream = stream;
    for (const track of stream.getAudioTracks())
      this.pc.addTrack(track, stream);
    this.camera = stream.getVideoTracks()[0] ?? null;
    this.videoSender = this.camera
      ? this.pc.addTrack(this.camera, stream)
      : this.pc.addTransceiver("video", {
          direction: "sendrecv",
          streams: [stream],
        }).sender;
    this.publishLocalStream();
  }

  private publishLocalStream(): void {
    this.config.onLocalStream(
      new MediaStream([
        ...(this.localStream?.getAudioTracks() ?? []),
        ...(this.screenStream?.getVideoTracks() ??
          (this.camera ? [this.camera] : [])),
      ]),
    );
  }

  flushIceCandidatesNow(): void {
    if (!this.candidates.length) return;
    const candidates = this.candidates.splice(0);
    this.config.onIceCandidates(candidates);
  }

  async createOffer(): Promise<string> {
    if (!this.pc) throw new Error("Call is not initialized");
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer.sdp ?? "";
  }

  async handleOffer(sdp: string): Promise<string> {
    if (!this.pc) throw new Error("Call is not initialized");
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    await this.processPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer.sdp ?? "";
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) throw new Error("Call is not initialized");
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await this.processPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc?.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  private async processPendingCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates.splice(0))
      await this.pc!.addIceCandidate(candidate);
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    if (!this.videoSender || !this.localStream)
      throw new Error("Call is not initialized");
    if (enabled && (!this.camera || this.camera.readyState === "ended")) {
      this.cameraRequest ??= navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user" },
      });
      try {
        const stream = await this.cameraRequest;
        if (this.disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.camera = stream.getVideoTracks()[0] ?? null;
      } finally {
        this.cameraRequest = null;
      }
    }
    if (!enabled) {
      // Stop capture, not just transmission: camera-off must release the device.
      this.camera?.stop();
      this.camera = null;
    } else if (this.camera) this.camera.enabled = true;
    if (!this.screenStream)
      await this.videoSender.replaceTrack(enabled ? this.camera : null);
    this.publishLocalStream();
  }

  async startScreenShare(): Promise<MediaStream> {
    if (!this.videoSender) throw new Error("Call is not initialized");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Call ended");
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error("No screen selected");
    }
    try {
      await this.videoSender.replaceTrack(track);
    } catch (error) {
      stream.getTracks().forEach((item) => item.stop());
      throw error;
    }
    if (this.disposed) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error("Call ended");
    }
    this.screenStream = stream;
    track.onended = () => {
      void this.stopScreenShare().catch((error) =>
        this.config.onError(String(error)),
      );
    };
    this.publishLocalStream();
    return stream;
  }

  async stopScreenShare(): Promise<void> {
    const stream = this.screenStream;
    this.screenStream = null;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    await this.videoSender?.replaceTrack(
      this.camera?.enabled ? this.camera : null,
    );
    this.publishLocalStream();
    this.config.onScreenShareEnded();
  }

  cleanup(): void {
    this.disposed = true;
    this.screenStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.camera?.stop();
    this.remoteStream.getTracks().forEach((track) => track.stop());
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onicegatheringstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.localStream = null;
    this.screenStream = null;
    this.camera = null;
    this.pendingCandidates = [];
    this.candidates = [];
  }
}
