import {
  readableStreamFromReader,
  writableStreamFromWriter,
} from "https://deno.land/std@0.98.0/io/streams.ts";

export interface FFmpegStreamOptions {
  path?: string;
  args: string[];
  chunkSize?: number;
  stderr?: boolean;
}

export class FFmpegStream extends ReadableStream<Uint8Array> {
  #proc?: Deno.Process;
  #stderr?: ReadableStream<string>;
  #stdin?: WritableStream<Uint8Array>;

  get proc() {
    if (!this.#proc) {
      this.#proc = Deno.run({
        cmd: [(this.options.path || "ffmpeg"), ...this.options.args],
        stdout: "piped",
        stderr: this.options.stderr ? "piped" : "null",
        stdin: "piped",
      });
    }

    if (this.#proc.stderr) {
      this.#stderr = readableStreamFromReader(this.#proc.stderr).pipeThrough(
        new TextDecoderStream(),
      );
    }
    this.#stdin = writableStreamFromWriter(this.#proc.stdin!);
    return this.#proc;
  }

  get stderr() {
    if (!this.#stderr) {
      if (this.proc.stderr) {
        this.#stderr = readableStreamFromReader(this.proc.stderr).pipeThrough(
          new TextDecoderStream(),
        );
      }
    }

    return this.#stderr;
  }

  get stdin() {
    if (!this.#stdin) {
      this.#stdin = writableStreamFromWriter(this.proc.stdin!);
    }

    return this.#stdin;
  }

  constructor(public options: FFmpegStreamOptions) {
    super({
      pull: async (ctx) => {
        const proc = this.proc;

        for await (
          const chunk of readableStreamFromReader(proc.stdout!, {
            chunkSize: options.chunkSize,
          })
        ) {
          ctx.enqueue(chunk);
        }

        ctx.close();
        proc.close();
      },
    });
  }
}

export class PCMStream extends FFmpegStream {
  constructor(path: string) {
    super({
      args: [
        "-i",
        path,
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-",
      ],
    });
  }
}

const I16_MIN = 2 ** 16 / 2 - 1;
const I16_MAX = -1 * I16_MIN;

export class VolumeTransformer extends TransformStream<Uint8Array, Uint8Array> {
  constructor(public options: { volume: number }) {
    super({
      transform(chunk, ctx) {
        chunk = chunk.slice(); // todo: do we have to copy to prevent mutating passed buffer?
        const view = new DataView(chunk.buffer);

        for (let i = 0; i < chunk.length; i += 2) {
          view.setInt16(
            i,
            Math.max(
              I16_MAX,
              Math.min(I16_MIN, options.volume * view.getInt16(i, true)),
            ),
            true,
          );
        }

        ctx.enqueue(chunk);
      },
    });
  }
}
