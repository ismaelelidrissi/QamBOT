// Qambot.js (ESM-ready) — QamBOT improved (safer disconnects, better perms, debounce writes)
import dotenv from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "fs";
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
  PermissionsBitField,
  EmbedBuilder,
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
let rawConfig = {};
try {
  rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  console.error("Failed to parse config.json:", e);
  process.exit(1);
}

// Basic defaults + validation
const DEBUG = Boolean(rawConfig.debug || process.env.DEBUG === "true");

function logDebug(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

const config = {
  presenceTimeout: rawConfig.presenceTimeout,
  leoBotId: rawConfig.leoBotId || null,
  mappings: rawConfig.mappings || {},
  checkinChannelId: rawConfig.checkinChannelId || null,
  checkinHour:
    Number.isFinite(Number.parseInt(rawConfig.checkinHour, 10)) &&
    Number.parseInt(rawConfig.checkinHour, 10) >= 0
      ? Number.parseInt(rawConfig.checkinHour, 10)
      : 9,
  checkinMinute:
    Number.isFinite(Number.parseInt(rawConfig.checkinMinute, 10)) &&
    Number.parseInt(rawConfig.checkinMinute, 10) >= 0
      ? Number.parseInt(rawConfig.checkinMinute, 10)
      : 0,
  debug: Boolean(rawConfig.debug || false),
};

let PRESENCE_TIMEOUT = Number.parseInt(config.presenceTimeout, 10);
if (!Number.isFinite(PRESENCE_TIMEOUT) || PRESENCE_TIMEOUT <= 0) {
  console.warn(
    "Invalid presenceTimeout in config.json — using default 60s (was:",
    config.presenceTimeout,
    ")"
  );
  PRESENCE_TIMEOUT = 60;
}

const LEO_BOT_ID = config.leoBotId || null;
const MAPPINGS = config.mappings || {};
const CHECKIN_CHANNEL_ID = config.checkinChannelId || null;

const DATA_PATH = join(__dirname, "data.json");
let DATA = { users: {}, lastDailyAt: null };
if (existsSync(DATA_PATH)) {
  try {
    DATA = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  } catch (e) {
    console.warn("Failed to read data.json, starting fresh.", e);
    DATA = { users: {}, lastDailyAt: null };
  }
}

// --- debounced save
let saveScheduled = false;
function saveDataImmediate() {
  try {
    writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2));
  } catch (e) {
    console.error("Failed to save data.json", e);
  }
}
function saveData() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    saveDataImmediate();
  }, 2000);
}

function ensureUser(id) {
  if (!DATA.users[id]) {
    DATA.users[id] = {
      xp: 0,
      streak: 0,
      lastCheckinDate: null,
      infractions: 0,
      breakJoins: [],
    };
    saveData();
  }
  return DATA.users[id];
}

function addXP(userId, amount) {
  const u = ensureUser(userId);
  u.xp = (u.xp || 0) + amount;
  saveData();
}

function addInfraction(userId) {
  const u = ensureUser(userId);
  u.infractions = (u.infractions || 0) + 1;
  saveData();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const activeSessions = new Map();
const breakStayTimeouts = new Map(); // key: userId_channelId -> timeoutId
const BREAK_KEYWORDS = ["break", "coffee", "pause", "休息"];

// dedupe sets
const recentHandledMessages = new Set();
setInterval(() => recentHandledMessages.clear(), 10 * 1000);
const recentFocusTriggers = new Set();

// debug logging hooks
client.on("channelUpdate", (oldC, newC) => {
  try {
    logDebug(
      "[channelUpdate] old:",
      oldC?.id,
      oldC?.name,
      "=> new:",
      newC?.id,
      newC?.name
    );
  } catch (e) {
    console.error("[channelUpdate error]", e);
  }
});
client.on("messageCreate", (msg) => {
  try {
    if (!msg.guild) return;
    const preview = (msg.content || "").slice(0, 200).replace(/\n/g, " ");
    logDebug(
      "[messageCreate] guild:",
      msg.guild.id,
      "author:",
      msg.author.id,
      "content:",
      preview
    );
  } catch (e) {
    console.error("[messageCreate error]", e);
  }
});

client.once("ready", async () => {
  console.log(`Ready as ${client.user.tag}`);
  try {
    // mapping validation to surface config issues
    for (const [voiceId, textId] of Object.entries(MAPPINGS)) {
      let found = false;
      for (const [, g] of client.guilds.cache) {
        const voice = g.channels.cache.get(voiceId);
        const text = g.channels.cache.get(textId);
        if (voice || text) {
          console.log(
            `[MAPPING] guild:${
              g.id
            } mapping voice(${voiceId}) -> text(${textId}) found: voiceName='${
              voice?.name || "N/A"
            }' textName='${text?.name || "N/A"}'`
          );
          found = true;
          break;
        }
      }
      if (!found) {
        console.warn(
          `[MAPPING WARN] mapping references channels not found in any cached guild: voice ${voiceId} -> text ${textId}`
        );
      }
    }

    for (const [, g] of client.guilds.cache) {
      const vcs = g.channels.cache.filter(
        (ch) => ch.type === ChannelType.GuildVoice
      );
      console.log(`[GUILD ${g.id}] voice channels:`);
      for (const [, vc] of vcs) console.log(` - ${vc.id} => ${vc.name}`);
    }

    scheduleDailyCheckin(config.checkinHour, config.checkinMinute);
  } catch (e) {
    console.error("[ready error]", e);
  }
});

// helper to get mapped text channel
function getNotifyChannelForVoice(guild, voiceChannelId) {
  const textId = MAPPINGS[voiceChannelId];
  if (!textId) return null;
  return guild.channels.cache.get(textId) || null;
}

// messageCreate (commands + triggers)
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    if (recentHandledMessages.has(message.id)) return;
    recentHandledMessages.add(message.id);

    const content = (message.content || "").trim();

    // Always allow commands from users (help, checkin, xp, etc.)
    if (content.startsWith("!")) {
      const parts = content.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === "help") {
        const helpEmbed = new EmbedBuilder()
          .setTitle("📘 نظام التحفيز — QamBOT")
          .setColor(0x00b0f4)
          .setDescription(
            "**🔥 كيفاش كيخدم QamBOT؟ كلشي مبسّط هنا:**\n\n" +
              "• اضغط **Present** في رسالة الـ Focus باش تسجل حضورك وتعطيك XP.\n" +
              "• أوامر مفيدة: `!checkin`, `!xp`, `!streak`, `!leaderboard`, `!startfocus`, `!endfocus`.\n\n" +
              "**أمثلة:**\n" +
              "• `!startfocus <voiceChannelId>` - ابدأ جلسة Focus تجريبية (يرسل رسالة Present في هاد القناة النصية).\n" +
              "• `!checkin` - تسجيل الحضور اليومي.\n" +
              "• `!xp` - عرض XP.\n"
          )
          .setFooter({
            text: "استعمل !startfocus لتجربة زر Present (أو تأكد من MAPPINGS في config.json)",
          });
        await message.reply({ embeds: [helpEmbed] });
        return;
      }

      if (cmd === "checkin") {
        const uid = message.author.id;
        const today = new Date().toISOString().slice(0, 10);
        const u = ensureUser(uid);
        if (u.lastCheckinDate === today) {
          await message.reply("✅ أنت سجلت حضورك لهذا اليوم بالفعل.");
        } else {
          const yesterday = new Date(Date.now() - 86400000)
            .toISOString()
            .slice(0, 10);
          if (u.lastCheckinDate === yesterday) u.streak = (u.streak || 0) + 1;
          else u.streak = 1;
          u.lastCheckinDate = today;
          saveData();
          await message.reply(
            `✅ تم تسجيل حضورك. ستريك الحالي: **${u.streak}** يوم.`
          );
        }
        return;
      }

      if (cmd === "xp") {
        const uid = message.author.id;
        const u = DATA.users[uid] || { xp: 0 };
        await message.reply(`✨ لديك **${u.xp || 0} XP**.`);
        return;
      }

      if (cmd === "leaderboard") {
        const arr = Object.entries(DATA.users).map(([id, u]) => ({
          id,
          xp: u.xp || 0,
        }));
        arr.sort((a, b) => b.xp - a.xp);
        const top = arr.slice(0, 5);
        let txt = "🏆 **Leaderboard (top 5 XP)**\n";
        for (let i = 0; i < top.length; i++) {
          const member = await message.guild.members
            .fetch(top[i].id)
            .catch(() => null);
          txt += `${i + 1}) ${member ? member.user.tag : top[i].id} — ${
            top[i].xp
          } XP\n`;
        }
        await message.reply(txt);
        return;
      }

      if (cmd === "streak") {
        const uid = message.author.id;
        const u = DATA.users[uid] || { streak: 0 };
        await message.reply(`🔥 ستريكك الحالي: **${u.streak || 0}** يوم.`);
        return;
      }

      if (cmd === "startfocus") {
        const parts = content.split(/\s+/);
        const vcId =
          parts[1] ||
          Object.keys(MAPPINGS).find((k) => MAPPINGS[k] === message.channel.id);
        if (!vcId)
          return message.reply(
            "Provide a voiceChannelId or use this command in a mapped text channel."
          );
        const vc = message.guild.channels.cache.get(vcId);
        if (!vc) return message.reply("Voice channel not found.");
        handleStartFocus(vc, message.channel);
        return;
      }

      if (cmd === "endfocus") {
        // admin only: ManageGuild or ManageChannels or server owner
        if (
          !message.member.permissions.has(
            PermissionsBitField.Flags.ManageGuild
          ) &&
          !message.member.permissions.has(
            PermissionsBitField.Flags.ManageChannels
          ) &&
          message.author.id !== message.guild.ownerId
        ) {
          return message.reply("You lack permission to run this command.");
        }
        const vcIdArg = parts[1];
        if (!vcIdArg)
          return message.reply("Usage: `!endfocus <voiceChannelId>`");
        const session = activeSessions.get(vcIdArg);
        if (!session)
          return message.reply("No active session for that voice channel.");
        try {
          if (session.timeout) clearTimeout(session.timeout);
        } catch (e) {}
        activeSessions.delete(vcIdArg);
        // try to clear original message components
        try {
          const ch = message.guild.channels.cache.get(session.notifyChannelId);
          if (ch && ch.isTextBased()) {
            const msg = await ch.messages
              .fetch(session.messageId)
              .catch(() => null);
            if (msg) await msg.edit({ components: [] }).catch(() => {});
          }
        } catch (e) {}
        return message.reply("Session ended.");
      }
    }

    // If LEO_BOT_ID is set, ignore non-LEO non-command triggers (we still accepted commands above)
    if (LEO_BOT_ID && message.author.id !== LEO_BOT_ID) {
      return;
    }

    const txt = (message.content || "").toLowerCase();

    // 1) channel mention mapping detection
    if (message.mentions?.channels?.size > 0) {
      for (const [, ch] of message.mentions.channels) {
        const chId = ch.id;
        const guildChannel = message.guild.channels.cache.get(chId);
        if (guildChannel) {
          if (
            guildChannel.type === ChannelType.GuildVoice &&
            MAPPINGS[guildChannel.id]
          ) {
            handleStartFocus(guildChannel, message.channel);
            return;
          }
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

    // 2) fallback keyword detection
    if (
      txt.includes("in focus") ||
      txt.includes("focus started") ||
      txt.includes("focus! good luck")
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

// voiceStateUpdate — break monitoring
client.on("voiceStateUpdate", (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const oldChan = oldState.channel;
    const newChan = newState.channel;

    if (oldChan && (!newChan || newChan.id !== oldChan.id)) {
      if (isBreakChannel(oldChan)) {
        const key = `${member.id}_${oldChan.id}`;
        const t = breakStayTimeouts.get(key);
        if (t) {
          clearTimeout(t);
          breakStayTimeouts.delete(key);
        }
      }
    }

    if (newChan && (!oldChan || oldChan.id !== newChan.id)) {
      if (isBreakChannel(newChan)) {
        recordBreakJoin(member.id);
        const key = `${member.id}_${newChan.id}`;
        const t = setTimeout(async () => {
          try {
            const freshMem = await newState.guild.members.fetch(member.id);
            if (freshMem.voice && freshMem.voice.channelId === newChan.id) {
              await freshMem
                .send(
                  `Hey ${freshMem.user.username}, يبدو أنك في البريك أكثر من 15 دقيقة. هل تريد الرجوع للدراسة؟`
                )
                .catch(() => {});
            }
          } catch (e) {
            /* ignore */
          }
        }, 15 * 60 * 1000);
        breakStayTimeouts.set(key, t);
      }
    }
  } catch (e) {
    console.error("voiceStateUpdate error", e);
  }
});

function isBreakChannel(channel) {
  if (!channel || !channel.name) return false;
  const name = channel.name.toLowerCase();
  return BREAK_KEYWORDS.some((k) => name.includes(k));
}

function recordBreakJoin(userId) {
  const u = ensureUser(userId);
  const now = Date.now();
  u.breakJoins = u.breakJoins || [];
  u.breakJoins = u.breakJoins.filter((t) => now - t < 60 * 60 * 1000);
  u.breakJoins.push(now);
  saveData();

  const recent = u.breakJoins.filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 3) {
    (async () => {
      try {
        for (const [, g] of client.guilds.cache) {
          try {
            const mem = await g.members.fetch(userId).catch(() => null);
            if (mem) {
              await mem
                .send(
                  `⏱️ لاحظت أنك تدخل غرفة البريك كثيرًا في آخر ساعة. حاول تقلل البريك وتزيد الفوكَس 😉`
                )
                .catch(() => {});
              break;
            }
          } catch (e) {
            /* ignore */
          }
        }
      } catch (e) {
        /* ignore */
      }
    })();
  }
}

// handleStartFocus (creates session, message with Present button)
async function handleStartFocus(voiceChannel, messageChannel = null) {
  const guild = voiceChannel.guild;
  const vcId = voiceChannel.id;

  if (recentFocusTriggers.has(vcId)) {
    logDebug("[DEDUP] ignoring trigger for", vcId);
    return;
  }
  recentFocusTriggers.add(vcId);
  setTimeout(() => recentFocusTriggers.delete(vcId), 5000);

  if (activeSessions.has(vcId)) {
    logDebug("Session already active for", vcId);
    return;
  }

  await guild.members.fetch();
  const membersInVC = voiceChannel.members.filter((m) => !m.user.bot);
  if (!membersInVC.size) {
    logDebug("No users in voice channel", voiceChannel.name);
    return;
  }

  const notifyChannel = getNotifyChannelForVoice(guild, vcId) || messageChannel;
  if (!notifyChannel || !notifyChannel.isTextBased()) {
    console.warn(
      `No mapped text channel for voice ${vcId} or target channel is not text-based. Add mapping in config.json`
    );
    return;
  }

  // check bot send/view perms on the notify channel
  try {
    const botMember =
      guild.members.me || guild.members.cache.get(client.user.id);
    const perms = notifyChannel.permissionsFor(botMember);
    if (
      !perms ||
      !perms.has(PermissionsBitField.Flags.ViewChannel) ||
      !perms.has(PermissionsBitField.Flags.SendMessages)
    ) {
      console.warn(
        `[FOCUS] Missing send/view perms in channel ${notifyChannel.id} (${notifyChannel.name}).`
      );
      return;
    }
  } catch (e) {
    /* ignore */
  }

  const waiting = new Set();
  const present = new Set();
  for (const [, mem] of membersInVC) waiting.add(mem.id);

  // customId should remain reasonably short (Discord limit 100 chars). vcId is numeric (snowflake).
  const customId = `present_${vcId}_${Date.now()}`;
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel("✅ Present")
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);

  let sentMsg = null;
  try {
    sentMsg = await notifyChannel.send({
      content: `**Focus started in** ${voiceChannel.name}\nIf you are present in the voice channel, press **Present** within ${PRESENCE_TIMEOUT} seconds or you may be removed.`,
      components: [row],
      allowedMentions: { parse: [] },
    });
    logDebug(
      "[FOCUS] present message sent:",
      sentMsg.id,
      "in",
      notifyChannel.id
    );
  } catch (e) {
    console.warn("Failed to send present message with button:", e);
    try {
      sentMsg = await notifyChannel.send({
        content: `**Focus started in** ${voiceChannel.name}\n(⚠️ Failed to attach Present button; check bot perms)`,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error("[FOCUS] cannot notify channel:", err);
      return;
    }
  }

  const timerObj = {
    guildId: guild.id,
    startedAt: Date.now(),
    voiceChannelId: vcId,
    waiting,
    present,
    messageId: sentMsg ? sentMsg.id : null,
    notifyChannelId: notifyChannel ? notifyChannel.id : null,
    customId,
    timeout: null,
  };
  activeSessions.set(vcId, timerObj);

  // cleanup listener: if message is deleted, cancel session
  // (we use a global listener below, but quick check here to attach nothing else)

  // timeout enforcement
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

      // check MoveMembers permission in the voice channel context
      const botMember =
        guild.members.me || guild.members.cache.get(client.user.id);
      const canMove =
        botMember &&
        botMember
          .permissionsIn(freshVC)
          .has(PermissionsBitField.Flags.MoveMembers);

      // If cannot move, we'll notify the mapped channel once (not DM everyone)
      const notifyIfCannotMove = !canMove && timerObj.notifyChannelId;

      for (const id of toDisconnect) {
        try {
          const member = await guild.members.fetch(id);
          if (member && member.voice && member.voice.channelId === vcId) {
            if (canMove) {
              try {
                await member.voice.setChannel(null);
              } catch (e) {
                console.warn("Failed to setChannel(null):", e);
                // notify mapped channel if available
                if (timerObj.notifyChannelId) {
                  const ch = guild.channels.cache.get(timerObj.notifyChannelId);
                  if (ch && ch.isTextBased()) {
                    await ch
                      .send({
                        content: `<@${member.id}> was marked for removal but moving failed. Please review.`,
                        allowedMentions: { users: [member.id] },
                      })
                      .catch(() => {});
                  }
                }
              }
            } else {
              // Inform mapped channel once
              if (notifyIfCannotMove) {
                const ch = guild.channels.cache.get(timerObj.notifyChannelId);
                if (ch && ch.isTextBased()) {
                  await ch
                    .send({
                      content: `<@${member.id}> was marked for removal for not pressing Present, but the bot lacks permission to move members. Please ask a moderator to review.`,
                      allowedMentions: { users: [member.id] },
                    })
                    .catch(() => {});
                }
              } else {
                // fallback single DM (best-effort, avoid spam)
                await member
                  .send(
                    "You were marked for removal for not pressing Present, but the bot lacks permission to move members. Please rejoin the focus session or contact a moderator."
                  )
                  .catch(() => {});
              }
            }
            logDebug(
              `Enforcement: processed ${member.user.tag} from ${voiceChannel.name}`
            );
            addInfraction(id);
          }
        } catch (err) {
          console.warn("Failed processing disconnect for", id, err);
        }
      }

      // cleanup session & try to remove button
      activeSessions.delete(vcId);
      if (sentMsg) {
        try {
          await sentMsg.edit({ components: [] }).catch(() => {});
        } catch (e) {}
      }
    } catch (err) {
      console.error("presence timeout handler error", err);
      activeSessions.delete(vcId);
    }
  }, PRESENCE_TIMEOUT * 1000);

  logDebug(
    `Enforcement started for ${voiceChannel.name} -> notify in ${notifyChannel.id}`
  );
}

// Interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;
    if (!customId.startsWith("present_")) return;

    const parts = customId.split("_"); // present_<vcId>_<ts>
    const vcId = parts[1];
    const session = activeSessions.get(vcId);

    if (!session) {
      return interaction.reply({
        content: "No active presence session for this channel or time expired.",
        ephemeral: true,
      });
    }

    const memberId = interaction.user.id;
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      return interaction.reply({
        content: "Guild not found.",
        ephemeral: true,
      });
    }
    await guild.members.fetch(memberId);
    const member = guild.members.cache.get(memberId);
    if (!member)
      return interaction.reply({
        content: "Member not found.",
        ephemeral: true,
      });
    if (!member.voice.channelId || member.voice.channelId !== vcId) {
      return interaction.reply({
        content: "You must be in the voice channel to mark Present.",
        ephemeral: true,
      });
    }
    if (session.present.has(memberId)) {
      return interaction.reply({
        content: "You've already marked Present.",
        ephemeral: true,
      });
    }

    session.present.add(memberId);
    session.waiting.delete(memberId);
    addXP(memberId, 10);

    const presentMentions = Array.from(session.present).map((id) => `<@${id}>`);
    const remaining = Array.from(session.waiting).length;
    const newContent = `**Focus started in** <#${
      session.voiceChannelId
    }> — Present recorded.\n\n✅ Marked present: ${
      presentMentions.join(", ") || "— none yet —"
    }\n⏱️ ${remaining} members still pending (press Present to confirm).`;

    const button = new ButtonBuilder()
      .setCustomId(session.customId)
      .setLabel("✅ Present")
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    try {
      await interaction.update({ content: newContent, components: [row] });
    } catch (e) {
      console.warn(
        "interaction.update failed, falling back to ephemeral reply:",
        e
      );
      await interaction.reply({
        content:
          "✅ Marked present — you earned **10 XP**! (Note: failed to update original message)",
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error("Interaction handler error", err);
  }
});

// cleanup active sessions if the present message is deleted
client.on("messageDelete", (deleted) => {
  try {
    if (!deleted) return;
    for (const [vcId, session] of activeSessions) {
      if (session.messageId && session.messageId === deleted.id) {
        try {
          if (session.timeout) clearTimeout(session.timeout);
        } catch (e) {}
        activeSessions.delete(vcId);
        logDebug(
          "[CLEANUP] removed active session for vc",
          vcId,
          "because message was deleted"
        );
        break;
      }
    }
  } catch (e) {
    console.error("messageDelete handler error", e);
  }
});

// daily checkin scheduling
function scheduleDailyCheckin(hour = 9, minute = 0) {
  try {
    const now = new Date();
    let next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const msUntil = next - now;
    setTimeout(() => {
      doDailyCheckin();
      setInterval(doDailyCheckin, 24 * 60 * 60 * 1000);
    }, msUntil);
    console.log(`[SCHEDULER] Daily checkin scheduled at ${hour}:${minute}`);
  } catch (e) {
    console.error("scheduleDailyCheckin error", e);
  }
}

async function doDailyCheckin() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (DATA.lastDailyAt === today) return;
    DATA.lastDailyAt = today;
    saveDataImmediate();

    if (CHECKIN_CHANNEL_ID) {
      for (const [, g] of client.guilds.cache) {
        const ch = g.channels.cache.get(CHECKIN_CHANNEL_ID);
        if (ch && ch.isTextBased()) {
          await ch
            .send(
              `📅 **Daily Check-in** — اضغط \`!checkin\` الآن لتسجل حضورك اليومي!`
            )
            .catch(() => {});
        }
      }
    } else {
      const sent = new Set();
      for (const [, g] of client.guilds.cache) {
        for (const [vId, tId] of Object.entries(MAPPINGS)) {
          if (tId && !sent.has(tId)) {
            const ch = g.channels.cache.get(tId);
            if (ch && ch.isTextBased()) {
              await ch
                .send(
                  `📅 **Daily Check-in** — اضغط \`!checkin\` الآن لتسجل حضورك اليومي!`
                )
                .catch(() => {});
              sent.add(tId);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("doDailyCheckin error", e);
  }
}

// graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down...");
  for (const [, s] of activeSessions) {
    try {
      if (s.timeout) clearTimeout(s.timeout);
    } catch (e) {}
  }
  saveDataImmediate();
  client.destroy();
  process.exit();
});

client.login(TOKEN);
