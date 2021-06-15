import { Encoder, readableStreamFromIterable, secretbox } from "../deps.ts";
import { VoicePlayer } from "./player.ts";
import { EncryptionMode, Speaking } from "./types.ts";
import { VoiceUDP } from "./udp.ts";
import { VoiceWebSocket } from "./ws.ts";

const CHANNELS = 2;
const SAMPLE_RATE = 48000;
const MAX_PACKET_SIZE = 28 + 1276 * 3;
const FRAME_DURATION = 20;
const FRAME_SIZE = SAMPLE_RATE * FRAME_DURATION / 1000;

const frame = new Uint8Array(MAX_PACKET_SIZE);
frame.set([0x80, 0x78], 0);

const encoder = new Encoder({
  channels: CHANNELS,
  application: "audio",
  max_opus_size: undefined as any,
  sample_rate: SAMPLE_RATE,
});

encoder.bitrate = 96000;
encoder.complexity = 10;
encoder.packet_loss = 2;
encoder.signal = "music";
encoder.inband_fec = true;

export interface VoiceConnectionConfig {
  mode?: EncryptionMode;
  receive?: "opus" | "pcm";
}

export class VoiceConnection {
  guildID?: string;
  channelID?: string;
  sessionID?: string;

  token?: string;
  endpoint?: string;

  ws: VoiceWebSocket;

  udp: VoiceUDP;

  mode?: EncryptionMode;
  #key = new Uint8Array(secretbox.key_length);

  get key() {
    return this.#key;
  }

  set key(val: Uint8Array) {
    this.#key.set(val);
  }

  #startTime = Date.now();
  #playTime = 0;
  #pausedTime = 0;
  #nextFrame?: number;
  paused = false;

  get ready() {
    return this.ws.ready;
  }

  constructor(
    public userID: string,
    public config: VoiceConnectionConfig = {},
  ) {
    this.ws = new VoiceWebSocket(this);
    this.udp = new VoiceUDP(this);
  }

  voiceStateUpdate({ guildID, channelID, sessionID }: {
    guildID: string;
    channelID: string;
    sessionID: string;
  }) {
    this.guildID = guildID;
    this.channelID = channelID;
    this.sessionID = sessionID;
  }

  voiceServerUpdate({ token, endpoint }: { token: string; endpoint: string }) {
    this.token = token;
    this.endpoint = endpoint;
  }

  connect() {
    this.ws.connect();
  }

  setSpeaking(...flags: (keyof typeof Speaking)[]) {
    return this.ws.sendSpeaking(
      flags.map((e) => Speaking[e]).reduce((a, b) => a | b, 0),
    );
  }

  #closables: CallableFunction[] = [];

  player() {
    const player = new VoicePlayer(this);
    this.#closables.push(() => {
      player.playing = false;
    });
    return player;
  }

  async playPCM(pcm: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    if (this.#nextFrame) {
      clearTimeout(this.#nextFrame);
      this.#nextFrame = undefined;
    }

    const iter = encoder.encode_pcm_stream(FRAME_SIZE, pcm);
    const stream = readableStreamFromIterable(
      iter as AsyncIterable<Uint8Array>,
    );
    const reader = stream.getReader();

    this.#startTime = Date.now();
    this.#playTime = 0;
    this.#pausedTime = 0;

    const frame = async () => {
      if (this.paused) {
        this.#pausedTime += FRAME_DURATION;
      } else {
        const res = await reader.read();

        if (res.done) {
          this.ws?.sendSpeaking(0);
          return;
        } else {
          const opus = res.value;
          await this.udp!.sendVoice(opus);
        }

        this.#playTime += FRAME_DURATION;
      }

      this.#nextFrame = setTimeout(
        frame,
        this.#startTime + this.#playTime + this.#pausedTime - Date.now(),
      );
    };

    this.ws?.sendSpeaking(Speaking.MICROPHONE);
    await frame();
  }

  readable(userID: string) {
    return this.udp.readable(userID);
  }

  close() {
    if (this.#nextFrame) {
      clearTimeout(this.#nextFrame);
      this.#nextFrame = undefined;
    }
    this.ws?.close();
    this.udp?.close();
  }
}
