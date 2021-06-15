import * as discord from "https://deno.land/x/harmony@v2.0.0-rc2/mod.ts";
import * as voice from "./mod.ts";
import ytsr from "https://deno.land/x/youtube_sr@v4.0.1-deno/mod.ts";
import { getInfo } from "https://deno.land/x/ytdl_core@0.0.1/mod.ts";
import { TOKEN } from "./config.ts";

const client = new discord.CommandClient({
  prefix: ".",
  token: TOKEN,
  intents: ["GUILDS", "GUILD_VOICE_STATES", "GUILD_MESSAGES"],
});

const conns = new discord.Collection<string, voice.VoiceConnection>();

client.commands.add(
  class extends discord.Command {
    name = "join";

    async execute(ctx: discord.CommandContext) {
      if (!ctx.guild) return;
      if (conns.has(client.user!.id)) {
        return ctx.message.reply("I've already joined VC.");
      }

      const vs = await ctx.guild.voiceStates.get(ctx.author.id);
      if (!vs || !vs.channel) {
        return ctx.message.reply("You're not in a Voice Channel.");
      }

      const data = await vs.channel.join({ deaf: true });

      const conn = new voice.VoiceConnection(client.user!.id, {
        mode: "xsalsa20_poly1305",
        receive: "opus",
      });

      conn.voiceStateUpdate({
        guildID: data.guild.id,
        channelID: vs.channel.id,
        sessionID: data.sessionID,
      });

      conn.voiceServerUpdate({ endpoint: data.endpoint, token: data.token });

      conn.connect();

      conns.set(ctx.guild.id, conn);

      ctx.message.reply("Joined Voice Channel!");
    }
  },
);

client.commands.add(
  class extends discord.Command {
    name = "play";

    async execute(ctx: discord.CommandContext) {
      if (!ctx.guild) return;
      if (!conns.has(ctx.guild.id)) {
        return ctx.message.reply(
          "I have not even joined a Voice Channel here.",
        );
      }

      const conn = conns.get(ctx.guild.id)!;
      if (!conn.ready) return ctx.message.reply("Connection not ready.");

      if (!ctx.argString.length) {
        return ctx.message.reply("Give some query for search!");
      }

      const search = await ytsr.searchOne(ctx.argString);
      if (!search || !search.id) return ctx.message.reply("Nothing found.");

      const info = await getInfo(search.id);
      const url = info.formats.find((e) => e.hasAudio && !e.hasVideo)!.url;

      const player = conn.player();
      const stream = new voice.PCMStream(url);
      stream.pipeTo(player.writable);

      ctx.message.reply("Playing now - " + search.title + "!");
    }
  },
);

client.commands.add(
  class extends discord.Command {
    name = "receive";

    async execute(ctx: discord.CommandContext) {
      if (!ctx.guild) return;
      if (!conns.has(ctx.guild.id)) {
        return ctx.message.reply(
          "I have not even joined a Voice Channel here.",
        );
      }

      const conn = conns.get(ctx.guild.id)!;

      const user = ctx.message.mentions.users.first();

      if (!user) {
        return ctx.message.reply("Mention someone to receive audio for.");
      }

      ctx.message.reply("Receiving now.");

      for await (const frame of conn.readable(user.id)) {
        console.log(frame);
      }
    }
  },
);

client.commands.add(
  class extends discord.Command {
    name = "leave";

    async execute(ctx: discord.CommandContext) {
      if (!ctx.guild) return;
      if (!conns.has(ctx.guild.id)) {
        return ctx.message.reply(
          "I have not even joined a Voice Channel here.",
        );
      }

      const conn = conns.get(ctx.guild.id);
      conn?.close();
      conns.delete(ctx.guild.id);

      const vs = await ctx.guild.voiceStates.get(client.user!.id);
      if (vs) {
        await vs.channel?.leave();
      }

      ctx.message.reply("Left voice channel.");
    }
  },
);

client.on("commandError", console.error);

client.connect().then(() => console.log("Connected!"));
