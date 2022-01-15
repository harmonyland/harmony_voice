# harmony_voice

Discord Voice API implementation for Deno.

## Features

- Built on modern Web Streams API.
- Works with any Discord API library with some effort.
- Experimental Voice Receive support.

## Usage

```ts
const conn = new VoiceConnect(botUserID);
// Obtained from VOICE_STATE_UPDATE Gateway Event
conn.voiceStateUpdate({ channelID, guildID, sessionID });
// Obtained from VOICE_SERVER_UPDATE
conn.voiceServerUpdate({ token, endpoint });

conn.connect();

// To play something
const player = conn.player();
pcmStreamFromSomewhere.pipeTo(player.writable);

// ytdl_core example
const player = conn.player();
const info = await getInfo("id"); // from x/ytdl_core

new PCMStream(stream.formats.find((e) => e.hasAudio && !e.hasVideo)!.url)
  .pipeTo(player.writable);
```

## License

Check [LICENSE](./LICENSE) for more info.

Copyright 2022 © DjDeveloperr
