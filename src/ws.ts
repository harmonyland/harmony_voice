import type { VoiceConnection } from "./conn.ts";
import { ENCRYPTION_MODE, OpCode, VOICE_VERSION } from "./types.ts";

export class VoiceWebSocket {
  ws?: WebSocket;

  ping = 0;
  #heartbeatInterval?: number;
  #heartbeatTimer?: number;
  #lastHeartbeatSent?: number;
  #lastHeartbeatACK?: number;

  ready = false;

  ssrc?: number;
  addr?: Deno.NetAddr;

  #ssrcMap: { [userID: string]: number } = {};

  getUserFromSSRC(ssrc: number): string | undefined {
    for (const id in this.#ssrcMap) {
      if (this.#ssrcMap[id] === ssrc) return id;
    }
  }

  constructor(public conn: VoiceConnection) {}

  connect() {
    if (this.conn.guildID === undefined) {
      throw new Error("Provide a Guild ID before connecting to WebSocket");
    }
    if (this.conn.userID === undefined) {
      throw new Error("Provide a User ID before connecting to WebSocket");
    }
    if (this.conn.token === undefined) {
      throw new Error(
        "Provide a Token (voice server) before connecting to WebSocket",
      );
    }
    if (this.conn.sessionID === undefined) {
      throw new Error("Provide a Session ID before connecting to WebSocket");
    }

    this.ready = false;
    this.ws = new WebSocket(`wss://${this.conn.endpoint}/?v=${VOICE_VERSION}`);

    this.ws.onopen = () => {
      console.log(`[WSS] Open`);
      this.sendIdentify();
    };

    this.ws.onclose = ({ code, reason }) => {
      if (this.#heartbeatTimer) {
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = undefined;
      }

      console.log(`[WSS] Close ${code} ${reason}`);
      switch (code) {
        case 1000:
        case 1005:
        case 4001:
        case 4002:
        case 4005:
        // case 4006:
        case 4009:
        case 4015:
          this.connect();
          break;

        case 0:
        case 4014:
          break;

        default:
          throw new Error(
            `Voice WebSocket closed with code: ${code} (${reason ||
              "no reason"})`,
          );
      }
    };

    this.ws.onmessage = (evt) => {
      const { op, d } = JSON.parse(evt.data);

      switch (op) {
        case OpCode.HELLO:
          this.#heartbeatInterval = d.heartbeat_interval as number;
          this.sendHeartbeat();
          this.#heartbeatTimer = setInterval(() => {
            if (
              this.#lastHeartbeatSent !== undefined &&
              this.#lastHeartbeatACK !== undefined &&
              this.#lastHeartbeatACK < this.#lastHeartbeatSent
            ) {
              clearInterval(this.#heartbeatTimer);
              this.#heartbeatTimer = undefined;
              this.ws!.close(1000, "Dead connection");
              return;
            }
            this.sendHeartbeat();
          }, this.#heartbeatInterval);
          break;

        case OpCode.READY:
          if (!d.modes.includes(ENCRYPTION_MODE)) {
            throw new Error("Encryption Mode not found");
          }

          this.ssrc = d.ssrc as number;
          this.conn.udp.frameView.setUint32(8, this.ssrc, false);

          this.addr = { hostname: d.ip, port: d.port, transport: "udp" };

          this.conn.udp.listen();

          this.conn.udp.ipDiscovery().then((addr) => {
            if (this.conn.config.receive) this.conn.udp._startReceiver();

            this.sendSelectProtocol({
              address: addr.hostname,
              port: addr.port,
            });
          });
          break;

        case OpCode.SESSION_DESCRIPTION:
          this.conn.key = d.secret_key;
          this.conn.mode = d.mode;
          this.ready = true;
          break;

        case OpCode.SPEAKING:
          this.#ssrcMap[d.user_id] = d.ssrc;
          break;

        case OpCode.HEARTBEAT_ACK:
          this.#lastHeartbeatACK = Date.now();

          if (this.#lastHeartbeatSent !== undefined) {
            this.ping = this.#lastHeartbeatACK - this.#lastHeartbeatSent;
          }
          break;

        case OpCode.CLIENT_DISCONNECT:
          delete this.#ssrcMap[d.user_id];
          break;

        case OpCode.RESUMED:
          break;

        default:
          break;
      }
    };

    this.ws.onerror = (evt) => {
      console.error(evt);
    };
  }

  sendWS(op: OpCode, data: any) {
    if (this.ws === undefined || this.ws.readyState !== this.ws.OPEN) {
      return false;
    }
    this.ws!.send(JSON.stringify({ op, d: data }));
    return true;
  }

  sendIdentify() {
    return this.sendWS(OpCode.IDENTIFY, {
      server_id: this.conn.guildID,
      user_id: this.conn.userID,
      session_id: this.conn.sessionID,
      token: this.conn.token,
    });
  }

  sendHeartbeat() {
    const sent = this.sendWS(OpCode.HEARTBEAT, Date.now());
    if (sent) this.#lastHeartbeatSent = Date.now();
    return sent;
  }

  sendSelectProtocol({ address, port }: { address: string; port: number }) {
    return this.sendWS(OpCode.SELECT_PROTOCOL, {
      protocol: "udp",
      data: { address, port, mode: this.conn.config.mode ?? ENCRYPTION_MODE },
    });
  }

  sendSpeaking(flags: number, delay = 0) {
    return this.sendWS(OpCode.SPEAKING, {
      speaking: flags,
      ssrc: this.ssrc,
      delay,
    });
  }

  close(code = 1000, reason = "") {
    this.ws?.close(code, reason);
  }
}
