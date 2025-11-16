// Qambot.js (ESM-ready) with DEBUG logs
import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ChannelType,
} from "discord.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("Missing TOKEN in .env");
  process.exit(1);
}

const configPath = join(__dirname, "config.json");
if (!existsSync(configPath)) {
  console.error("config.json not found. Create it as instructed.");
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const PRESENCE_TIMEOUT = Number(config.presenceTimeout || 60);
const LEO_BOT_ID = config.leoBotId || null;
const MAPPINGS = config.mappings || {};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const activeSessions = new Map();

// ----- DEBUG HELPERS (temporary) -----
client.on("channelUpdate", (oldC, newC) => {
  try {
    console.log(
      "[DEBUG channelUpdate] old:",
      oldC?.id,
      oldC?.name,
      "=> new:",
      newC?.id,
      newC?.name
    );
  } catch (e) {
    console.error("[DEBUG channelUpdate error]", e);
  }
});

client.on("messageCreate", (msg) => {
  try {
    if (!msg.guild) return;
    const preview = (msg.content || "").slice(0, 200).replace(/\n/g, " ");
    console.log(
      "[DEBUG messageCreate] guild:",
      msg.guild.id,
      "author:",
      msg.author.id,
      "name:",
      msg.author.username,
      "content:",
      preview
    );
    if (msg.embeds?.length)
      console.log("[DEBUG messageCreate] embeds count =", msg.embeds.length);
  } catch (e) {
    console.error("[DEBUG messageCreate error]", e);
  }
});

// ready prints mapping info and available voice channels
client.once("ready", async () => {
  console.log(`Ready as ${client.user.tag} (DEBUG MODE)`);
  try {
    for (const [voiceId, textId] of Object.entries(MAPPINGS)) {
      for (const [, g] of client.guilds.cache) {
        const voice = g.channels.cache.get(voiceId);
        const text = g.channels.cache.get(textId);
        if (voice || text) {
          console.log(
            `[DEBUG mapping] guild:${
              g.id
            } mapping voice(${voiceId}) -> text(${textId}) found: voiceName='${
              voice?.name || "N/A"
            }' textName='${text?.name || "N/A"}'`
          );
        }
      }
    }
    for (const [, g] of client.guilds.cache) {
      const vcs = g.channels.cache.filter(
        (ch) => ch.type === ChannelType.GuildVoice
      );
      console.log(`[DEBUG guild ${g.id}] voice channels:`);
      for (const [, vc] of vcs) console.log(` - ${vc.id} => ${vc.name}`);
    }
  } catch (e) {
    console.error("[DEBUG ready error]", e);
  }
});

// --- helper to get mapped text channel ---
function getNotifyChannelForVoice(guild, voiceChannelId) {
  const textId = MAPPINGS[voiceChannelId];
  if (!textId) return null;
  return guild.channels.cache.get(textId) || null;
}

client.on("channelUpdate", async (oldChannel, newChannel) => {
  try {
    if (!newChannel || newChannel.type !== ChannelType.GuildVoice) return;
    const oldName = oldChannel?.name || "";
    const newName = newChannel.name || "";
    if (
      !oldName.toUpperCase().includes("FOCUS") &&
      newName.toUpperCase().includes("FOCUS")
    ) {
      console.log(`Detected FOCUS on voice channel ${newChannel.id}`);
      handleStartFocus(newChannel);
    }
  } catch (err) {
    console.error("channelUpdate error", err);
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // If a leoBotId is set, optionally require the message to come from it.
    if (LEO_BOT_ID && message.author.id !== LEO_BOT_ID) {
      // Still allow admins to trigger? (skip) — we just return.
      return;
    }

    const txt = (message.content || "").toLowerCase();

    // 1) If the message mentions a channel like <#123456789>, extract it and try to handle that specific voice channel.
    if (
      message.mentions &&
      message.mentions.channels &&
      message.mentions.channels.size > 0
    ) {
      for (const [, ch] of message.mentions.channels) {
        // only consider if this is one of our mapped voice channels (in case Leo mentions text channels too)
        const chId = ch.id;
        // If the mentioned channel is a voice channel (rare via mentions) OR if it's the mapped voice id, try both
        const guildChannel = message.guild.channels.cache.get(chId);
        if (guildChannel) {
          // If it is voice and mapping exists, trigger
          if (
            guildChannel.type === ChannelType.GuildVoice &&
            MAPPINGS[guildChannel.id]
          ) {
            handleStartFocus(guildChannel, message.channel);
            return;
          }
          // If it's a text channel but it's used in our mappings as target, try to find the voice key that maps to this text channel
          const voiceId = Object.keys(MAPPINGS).find(
            (v) => MAPPINGS[v] === chId
          );
          if (voiceId) {
            const vc = message.guild.channels.cache.get(voiceId);
            if (vc) {
              handleStartFocus(vc, message.channel);
              return;
            }
          }
        }
      }
    }

    // 2) Otherwise fallback to keyword detection in message content (existing logic)
    if (
      txt.includes("in focus") ||
      txt.includes("focus! good luck") ||
      txt.includes("focus started")
    ) {
      const voiceChannels = message.guild.channels.cache.filter(
        (ch) => ch.type === ChannelType.GuildVoice
      );
      for (const [, vc] of voiceChannels) {
        const n = (vc.name || "").toLowerCase();
        if (
          (n.includes("pomodoro") ||
            n.includes("study") ||
            n.includes("focus")) &&
          n.includes("focus")
        ) {
          if (MAPPINGS[vc.id]) {
            handleStartFocus(vc, message.channel);
            return;
          }
        }
      }
    }
  } catch (err) {
    console.error("messageCreate error", err);
  }
});

async function handleStartFocus(voiceChannel, messageChannel = null) {
  const guild = voiceChannel.guild;
  const vcId = voiceChannel.id;
  if (activeSessions.has(vcId)) {
    console.log("Session already active for", vcId);
    return;
  }

  await guild.members.fetch();
  const membersInVC = voiceChannel.members.filter((m) => !m.user.bot);
  if (!membersInVC.size) {
    console.log("No users in voice channel", voiceChannel.name);
    return;
  }

  const notifyChannel = getNotifyChannelForVoice(guild, vcId) || messageChannel;
  if (!notifyChannel) {
    console.warn(
      `No mapped text channel for voice ${vcId}. Add mapping in config.json`
    );
    return;
  }

  const waiting = new Set();
  const present = new Set();
  for (const [, mem] of membersInVC) waiting.add(mem.id);

  const button = new ButtonBuilder()
    .setCustomId(`present_${vcId}_${Date.now()}`)
    .setLabel("✅ Present")
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  let sentMsg = null;
  try {
    sentMsg = await notifyChannel.send({
      content: `**Focus started in** ${voiceChannel.name}\nIf you are present in the voice channel, press **Present** within ${PRESENCE_TIMEOUT} seconds or you will be disconnected.`,
      components: [row],
    });
  } catch (e) {
    console.warn("Failed to send present message to mapped channel:", e);
  }

  const timerObj = {
    guildId: guild.id,
    startedAt: Date.now(),
    voiceChannelId: vcId,
    waiting,
    present,
    messageId: sentMsg ? sentMsg.id : null,
    notifyChannelId: notifyChannel ? notifyChannel.id : null,
    timeout: null,
  };
  activeSessions.set(vcId, timerObj);

  timerObj.timeout = setTimeout(async () => {
    try {
      const freshVC = guild.channels.cache.get(vcId);
      if (!freshVC) {
        activeSessions.delete(vcId);
        return;
      }
      await guild.members.fetch();
      const currentMembers = freshVC.members.filter((m) => !m.user.bot);
      const currentIds = new Set(currentMembers.map((m) => m.id));
      const toCheck = Array.from(timerObj.waiting).filter((id) =>
        currentIds.has(id)
      );
      const toDisconnect = toCheck.filter((id) => !timerObj.present.has(id));

      for (const id of toDisconnect) {
        try {
          const member = await guild.members.fetch(id);
          if (member && member.voice && member.voice.channelId === vcId) {
            // disconnect (use setChannel(null) for compatibility)
            try {
              await member.voice.setChannel(null);
            } catch (e) {
              // fallback to disconnect if supported
              if (member.voice.disconnect) {
                await member.voice.disconnect();
              }
            }
            console.log(
              `Disconnected ${member.user.tag} from ${voiceChannel.name}`
            );
            if (notifyChannel && notifyChannel.isTextBased()) {
              await notifyChannel.send(
                `${member.user} was disconnected for not pressing Present in time.`
              );
            }
          }
        } catch (err) {
          console.warn("Failed to disconnect member", id, err);
        }
      }

      activeSessions.delete(vcId);
      if (sentMsg) {
        try {
          await sentMsg.edit({ components: [] });
        } catch (e) {
          /*ignore*/
        }
      }
    } catch (err) {
      console.error("presence timeout handler error", err);
      activeSessions.delete(vcId);
    }
  }, PRESENCE_TIMEOUT * 1000);

  console.log(
    `Enforcement started for ${voiceChannel.name} -> notify in ${notifyChannel.id}`
  );
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;
    if (!customId.startsWith("present_")) return;

    const parts = customId.split("_"); // present_<vcId>_<ts>
    const vcId = parts[1];
    const session = activeSessions.get(vcId);
    if (!session) {
      await interaction.reply({
        content: "No active presence session for this channel or time expired.",
        ephemeral: true,
      });
      return;
    }

    const memberId = interaction.user.id;
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      await interaction.reply({ content: "Guild not found.", ephemeral: true });
      return;
    }
    await guild.members.fetch(memberId);
    const member = guild.members.cache.get(memberId);
    if (!member) {
      await interaction.reply({
        content: "Member not found.",
        ephemeral: true,
      });
      return;
    }
    if (!member.voice.channelId || member.voice.channelId !== vcId) {
      await interaction.reply({
        content: "You must be in the voice channel to mark Present.",
        ephemeral: true,
      });
      return;
    }

    session.present.add(memberId);
    session.waiting.delete(memberId);
    await interaction.reply({
      content: "✅ Marked present — good luck!",
      ephemeral: true,
    });
  } catch (err) {
    console.error("Interaction handler error", err);
  }
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  client.destroy();
  process.exit();
});

client.login(TOKEN);
