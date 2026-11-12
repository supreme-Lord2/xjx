# JuneX-Baileys runtime for sticker-pack commands

`telepack` and `takepack` share the same pack sender. It calls `sock.sendStickerPack()` if the active socket exposes that API; otherwise it uses the existing compatible pack upload-and-relay implementation. The bot entry point prefers `junexbaileys` and falls back to `@whiskeysockets/baileys` only if JunEx itself is not installed.

The supplied root `package.json` aliases `@whiskeysockets/baileys` to npm `junexbaileys@1.0.6`. That published release does **not** include `sock.sendStickerPack()`, so the commands use the compatible local sender rather than the library's native method. To use the native socket API, install a JuneX-Baileys build containing the `sendStickerPack` socket method. The bot logs its selected runtime package at startup.

`jsdom` was removed from the root dependencies as requested. The optional animated Telegram `.tgs` rendering helper still expects `jsdom`; that particular conversion path will report a missing dependency unless another compatible DOM implementation is provided.

## Post a reply as a channel status

The owner-only `.channelstatus` command (aliases `.chstatus` and `.cstatus`) posts replied-to text, image, video, audio, or sticker content to the channel saved with `.setnewsletter`. You can instead provide a channel JID or WhatsApp channel link as the first argument. Example: reply to a photo and send `.chstatus New update!`.

This command calls `sock.sendChannelStatus()`. As with the native sticker-pack sender, the currently selected npm `junexbaileys@1.0.6` does not include that API; install a JunEx release/build that exports it before expecting channel-status posting to succeed.
