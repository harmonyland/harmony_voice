import type { VoiceConnection } from "./conn.ts";
import {
  CHANNELS,
  FRAME_DURATION,
  FRAME_SIZE,
  MAX_PACKET_SIZE,
  SAMPLE_RATE,
} from "./types.ts";
import { Encoder, readableStreamFromIterable } from "../deps.ts";

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

export class VoicePlayer {
  #startTime = Date.now();
  #playTime = 0;
  #pausedTime = 0;
  #nextFrame?: number;
  playing = false;
  paused = false;
  #readable?: ReadableStream<Uint8Array>;
  #readableCtx?: ReadableStreamDefaultController<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  constructor(public conn: VoiceConnection) {
    this.writable = new WritableStream({
      start: () => {
        if (this.#nextFrame) {
          clearTimeout(this.#nextFrame);
          this.#nextFrame = undefined;
        }

        this.#startTime = Date.now();
        this.#playTime = 0;
        this.#pausedTime = 0;
        this.playing = true;

        this.#readable = new ReadableStream({
          start: (ctx) => {
            this.#readableCtx = ctx;
          },
        });

        const iter = encoder.encode_pcm_stream(FRAME_SIZE, this.#readable);
        const stream = readableStreamFromIterable(
          iter as AsyncIterable<Uint8Array>,
        );
        const reader = stream.getReader();

        const frame = async () => {
          if (!this.playing) return;

          if (this.paused) {
            this.#pausedTime += FRAME_DURATION;
          } else {
            const res = await reader.read();

            if (res.done) {
              this.playing = false;
              this.conn.setSpeaking();
              return;
            } else {
              const opus = res.value;
              try {
                await this.conn.udp!.sendVoice(opus);
              } catch (e) {}
            }

            this.#playTime += FRAME_DURATION;
          }

          this.#nextFrame = setTimeout(
            frame,
            this.#startTime + this.#playTime + this.#pausedTime - Date.now(),
          );
        };

        this.conn.setSpeaking("MICROPHONE");
        frame().catch(() => {
          this.playing = false;
        });
      },
      write: (chunk) => {
        this.#readableCtx?.enqueue(chunk);
      },
      close: () => {
        this.#readableCtx?.close();
      },
    });
  }
}
