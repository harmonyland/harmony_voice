import type { VoiceConnection } from "./conn.ts";
import { secretbox } from "../deps.ts";
import {
  ENCRYPTION_MODE,
  FRAME_SIZE,
  MAX_PACKET_SIZE,
  MAX_SEQ,
  MAX_TIMESTAMP,
} from "./types.ts";

const frame = new Uint8Array(MAX_PACKET_SIZE);
frame.set([0x80, 0x78], 0);

const textDecoder = new TextDecoder();

export class VoiceUDP {
  socket?: Deno.DatagramConn;

  #nonce = new Uint8Array(secretbox.nonce_length);
  #nonceView = new DataView(this.#nonce.buffer);

  #frame = frame.slice();
  #frameView = new DataView(this.#frame.buffer);

  get frameView() {
    return this.#frameView;
  }

  #seq = 0;
  #timestamp = 0;
  #nonceIncr?: number;

  #receivers: {
    [user: string]: [ReadableStream, ReadableStreamDefaultController];
  } = {};

  constructor(public conn: VoiceConnection) {}

  listen() {
    if (this.socket) {
      this.socket.close();
    }

    this.socket = Deno.listenDatagram({
      hostname: "0.0.0.0",
      port: 0,
      transport: "udp",
    });
  }

  #recvStarted = false;

  async _startReceiver() {
    if (this.#recvStarted) return false;
    this.#recvStarted = true;
    const receive = async () => {
      try {
        const [data] = await this.socket!.receive();
        if (data[0] === 0x80 && data[1] === 0x78 && data.length >= 12) {
          const view = new DataView(data.buffer);
          const ssrc = view.getUint32(8, false);

          const userID = this.conn.ws.getUserFromSSRC(ssrc);
          if (userID) {
            const nonce = new Uint8Array(secretbox.nonce_length);
            let end;
            switch (
              this.conn.mode ?? this.conn.config.mode ?? ENCRYPTION_MODE
            ) {
              case "xsalsa20_poly1305":
                nonce.set(data.subarray(0, 12));
                end = data.length;
                break;

              case "xsalsa20_poly1305_lite":
                nonce.set(data.subarray(data.length - 4, data.length));
                end = data.length - 4;
                break;

              case "xsalsa20_poly1305_suffix":
                nonce.set(data.subarray(data.length - 24, data.length));
                end = data.length - 24;
                break;

              default:
                throw new Error(
                  "Unsupported encryption mode " + this.conn.mode,
                );
            }

            const audio = data.subarray(12, end);
            const opus = secretbox.open(audio, this.conn.key, nonce);

            this.readable(userID); // ensure stream exists
            const ctx = this.#receivers[userID][1];

            if (this.conn.config.receive === "opus") {
              ctx.enqueue(opus);
            } else {
              ctx.enqueue(opus);
            }
          }
        } // ignore other packets
        await receive();
      } catch (e) {}
    };
    await receive();
  }

  async ipDiscovery(): Promise<Deno.NetAddr> {
    const buf = new Uint8Array(70);

    let view = new DataView(buf.buffer);
    view.setUint16(0, 0x1, false);
    view.setUint16(2, 70, false);
    view.setUint32(4, this.conn.ws?.ssrc!, false);

    await this.socket!.send(buf, this.conn.ws?.addr!);

    const [recv] = await this.socket!.receive();
    view = new DataView(recv.buffer);
    const port = view.getUint16(recv.byteLength - 2, false);
    const hostname = textDecoder.decode(
      recv.subarray(1 + recv.indexOf(0, 3), recv.indexOf(0, 4)),
    );

    return { port, hostname, transport: "udp" };
  }

  readable(userID: string): ReadableStream {
    const has = this.#receivers[userID]?.[0];
    if (has) return has;
    else {
      let ctx: ReadableStreamDefaultController | undefined;
      const stream = new ReadableStream({
        start: (c) => {
          ctx = c;
        },
      });
      this.#receivers[userID] = [stream, ctx!];
      return stream;
    }
  }

  async sendVoice(opus: Uint8Array) {
    this.#seq++;
    if (MAX_SEQ <= this.#seq) {
      this.#seq -= MAX_SEQ;
    }

    this.#timestamp += FRAME_SIZE;
    if (MAX_TIMESTAMP <= this.#timestamp) {
      this.#timestamp %= MAX_TIMESTAMP;
    }

    this.#frameView.setUint16(2, this.#seq, false);
    this.#frameView.setUint32(4, this.#timestamp, false);

    let audio;
    let end;
    switch (this.conn.mode) {
      case "xsalsa20_poly1305":
        // Nonce is 12 bytes copied from RTP header
        this.#nonce.set(this.#frame.subarray(0, 12));

        audio = secretbox.seal(opus, this.conn.key, this.#nonce);
        this.#frame.set(audio, 12);
        end = audio.length + 12;
        break;

      case "xsalsa20_poly1305_suffix":
        // Nonce is random 24 bytes
        crypto.getRandomValues(this.#nonce);

        audio = secretbox.seal(opus, this.conn.key, this.#nonce);
        this.#frame.set(audio, 12);
        // Nonce is stored in last 24 bytes of frame
        this.#frame.set(this.#nonce, 12 + audio.length);
        end = audio.length + 12 + 24;
        break;

      case "xsalsa20_poly1305_lite":
        // Nonce is a incrementing u32
        this.#nonceIncr = this.#nonceIncr || -1;
        this.#nonceIncr++;
        if (MAX_TIMESTAMP <= this.#nonceIncr) this.#nonceIncr = 0;
        this.#nonceView.setUint32(0, this.#nonceIncr, false);

        audio = secretbox.seal(opus, this.conn.key, this.#nonce);
        this.#frame.set(audio, 12);
        // Nonce is stored in last 4 bytes of frame
        this.#frame.set(this.#nonce.subarray(0, 4), 12 + audio.length);
        end = audio.length + 12 + 4;
        break;

      default:
        throw new Error("Unsupported encryption mode");
    }

    const buffer = this.#frame.subarray(0, end);
    return this.socket!.send(
      buffer,
      this.conn.ws?.addr!,
    );
  }

  close() {
    this.socket!.close();
  }
}
