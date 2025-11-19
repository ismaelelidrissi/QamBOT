// Qambot.js (ESM-ready) — QamBOT improved (small fixes + better permission handling)
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
const config = JSON.parse(readFileSync(configPath, "utf8"));
const PRESENCE_TIMEOUT = Number(config.presenceTimeout || 60);
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

function saveData() {
  try {
    writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2));
  } catch (e) {
    console.error("Failed to save data.json", e);
  }
}

function ensureUser(id) {
  if (!DATA.users[id]) {
    DATA.users[id] = {
      xp: 0,
      streak: 0,
      lastCheckinDate: null,
      infractions: 0,
      breakJoins: [], // timestamps of joins to break rooms
    };
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
  partials: [Partials.Channel],
});

const activeSessions = new Map();
const breakStayTimeouts = new Map(); // key: userId -> timeoutId
const BREAK_KEYWORDS = ["break", "coffee", "pause", "休息"];

// ---------- DEDUPE + COOLDOWNS ----------
const recentHandledMessages = new Set();
setInterval(() => recentHandledMessages.clear(), 10 * 1000);

const recentFocusTriggers = new Set();

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

    // schedule daily checkin at config hour (default 9)
    const cfgHour = Number(config.checkinHour ?? 9);
    const cfgMinute = Number(config.checkinMinute ?? 0);
    scheduleDailyCheckin(cfgHour, cfgMinute);
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

// ---------- messageCreate (commands + detection) ----------
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // quick dedupe
    if (recentHandledMessages.has(message.id)) return;
    recentHandledMessages.add(message.id);

    const content = (message.content || "").trim();

    // --- Commands (prefix !) available to everyone ---
    if (LEO_BOT_ID && message.author && message.author.id === LEO_BOT_ID) {
      if (message.mentions?.channels?.size) {
        for (const [, ch] of message.mentions.channels) {
          const guildChannel = message.guild.channels.cache.get(ch.id);
          if (guildChannel && guildChannel.type === ChannelType.GuildVoice) {
            handleStartFocus(guildChannel, message.channel);
            break;
          }
        }
      } else {
        const vcId = Object.keys(MAPPINGS).find(
          (k) => MAPPINGS[k] === message.channel.id
        );
        if (vcId) {
          const vc = message.guild.channels.cache.get(vcId);
          if (vc) handleStartFocus(vc, message.channel);
        }
      }
    }

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
              "• أوامر مفيدة: `!checkin`, `!xp`, `!streak`, `!leaderboard`, `!startfocus`.\n\n" +
              "**أمثلة:**\n" +
              "• `!startfocus <voiceChannelId>` - ابدأ جلسة Focus تجريبية (يرسل رسالة Present في هاد القناة النصية).\n" +
              "• `!checkin` - تسجيل الحضور اليومي.\n" +
              "• `!xp` - عرض XP.\n" +
              "• `!leaderboard` - أفضل 5 حسب XP.\n"
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
          if (u.lastCheckinDate === yesterday) {
            u.streak = (u.streak || 0) + 1;
          } else {
            u.streak = 1;
          }
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
        if (!vcId) {
          return message.reply(
            "Provide a voiceChannelId or use this command in a mapped text channel."
          );
        }
        const vc = message.guild.channels.cache.get(vcId);
        if (!vc) return message.reply("Voice channel not found.");
        handleStartFocus(vc, message.channel);
        return;
      }
    }

    // If LEO_BOT_ID set, only accept triggers/messages from that bot for starting focus (after commands)
    if (LEO_BOT_ID && message.author.id !== LEO_BOT_ID) {
      return;
    }

    const txt = (message.content || "").toLowerCase();

    // 1) check channel mentions to map to VC
    if (
      message.mentions &&
      message.mentions.channels &&
      message.mentions.channels.size > 0
    ) {
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

    // 2) fallback keyword detection (simple)
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

// ---------- voiceStateUpdate for break monitoring ----------
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
              await freshMem.send(
                `Hey ${freshMem.user.username}, يبدو أنك في البريك أكثر من 15 دقيقة. هل تريد الرجوع للدراسة؟ 💪`
              );
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
              await mem.send(
                `⏱️ لاحظت أنك تدخل غرفة البريك كثيرًا في آخر ساعة. حاول تقلل البريك وتزيد الفوكَس 😉`
              );
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

// ---------- handleStartFocus (robust, stores customId + messageId in session) ----------
async function handleStartFocus(voiceChannel, messageChannel = null) {
  const guild = voiceChannel.guild;
  const vcId = voiceChannel.id;

  if (recentFocusTriggers.has(vcId)) {
    console.log("[DEDUP FOCUS] ignoring duplicate trigger for", vcId);
    return;
  }
  recentFocusTriggers.add(vcId);
  setTimeout(() => recentFocusTriggers.delete(vcId), 5000);

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
  if (!notifyChannel || !notifyChannel.isTextBased()) {
    console.warn(
      `No mapped text channel for voice ${vcId} or target channel is not text-based. Add mapping in config.json`
    );
    return;
  }

  // quick permissions check: need VIEW + SEND to post, and MOVE_MEMBERS to force-disconnect users later
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
    // ignore permission-check errors
  }

  const waiting = new Set();
  const present = new Set();
  for (const [, mem] of membersInVC) waiting.add(mem.id);

  const customId = `present_${vcId}_${Date.now()}`; // unique per session
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel("✅ Present")
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);

  let sentMsg = null;
  try {
    sentMsg = await notifyChannel.send({
      content: `**Focus started in** ${voiceChannel.name}\nIf you are present in the voice channel, press **Present** within ${PRESENCE_TIMEOUT} seconds or you will be disconnected.`,
      components: [row],
      allowedMentions: { parse: [] },
    });
    console.log(
      "[FOCUS] present message sent:",
      sentMsg.id,
      "in",
      notifyChannel.id
    );
  } catch (e) {
    console.warn("Failed to send present message to mapped channel:", e);
    try {
      sentMsg = await notifyChannel.send({
        content: `**Focus started in** ${voiceChannel.name}\n(⚠️ Failed to attach Present button; check bot perms)`,
        allowedMentions: { parse: [] },
      });
      console.log("[FOCUS] fallback plain message sent:", sentMsg.id);
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

  // Keep a reference to timeout so we can clear it if session cancelled
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

      // check bot has permission to move members before attempting disconnects
      const botMember =
        guild.members.me || guild.members.cache.get(client.user.id);
      const canMove =
        botMember &&
        botMember.permissions.has(PermissionsBitField.Flags.MoveMembers);

      for (const id of toDisconnect) {
        try {
          const member = await guild.members.fetch(id);
          if (member && member.voice && member.voice.channelId === vcId) {
            try {
              if (canMove) {
                await member.voice.setChannel(null);
              } else {
                // fallback: send DM + notify channel if cannot disconnect
                await member.send(
                  "You were marked for disconnection for not pressing Present, but the bot lacks permission to move members."
                );
                if (notifyChannel && notifyChannel.isTextBased()) {
                  await notifyChannel.send(
                    `${member.user} did not press Present in time (bot lacks Move Members permission).`
                  );
                }
              }
            } catch (e) {
              console.warn(
                "Failed to disconnect member via setChannel. Trying voice.disconnect if available.",
                e
              );
              try {
                if (member.voice.disconnect) {
                  await member.voice.disconnect();
                }
              } catch (e2) {
                console.warn("voice.disconnect also failed", e2);
              }
            }
            console.log(
              `Enforcement: processed ${member.user.tag} from ${voiceChannel.name}`
            );
            addInfraction(id);
          }
        } catch (err) {
          console.warn("Failed to process member disconnect", id, err);
        }
      }

      // cleanup: remove active session and try to remove buttons
      activeSessions.delete(vcId);
      if (sentMsg) {
        try {
          await sentMsg.edit({ components: [] });
        } catch (e) {
          // ignore
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

// ---------- Interaction handler (mark present and award XP) ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;
    if (!customId.startsWith("present_")) return;

    // find vcId from customId
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
    if (!member) {
      return interaction.reply({
        content: "Member not found.",
        ephemeral: true,
      });
    }
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

    // mark present and award XP
    session.present.add(memberId);
    session.waiting.delete(memberId);
    addXP(memberId, 10);

    // Build new content with present list
    const presentMentions = Array.from(session.present).map((id) => `<@${id}>`);
    const remaining = Array.from(session.waiting).length;
    const newContent =
      `**Focus started in** <#${session.voiceChannelId}> — Present recorded.\n\n` +
      `✅ Marked present: ${presentMentions.join(", ") || "— none yet —"}\n` +
      `⏱️ ${remaining} members still pending (press Present to confirm).`;

    // Keep same button (others can still press)
    const button = new ButtonBuilder()
      .setCustomId(session.customId)
      .setLabel("✅ Present")
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    // Use interaction.update to edit the original message (prevents extra notifications)
    try {
      await interaction.update({ content: newContent, components: [row] });
    } catch (e) {
      // if update fails (message deleted or out-of-sync), fallback to ephemeral reply
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

// ---------- helper: scheduling daily checkin ----------
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
    saveData();

    if (CHECKIN_CHANNEL_ID) {
      for (const [, g] of client.guilds.cache) {
        const ch = g.channels.cache.get(CHECKIN_CHANNEL_ID);
        if (ch && ch.isTextBased()) {
          await ch.send(
            `📅 **Daily Check-in** — اضغط \`!checkin\` الآن لتسجل حضورك اليومي!`
          );
        }
      }
    } else {
      const sent = new Set();
      for (const [, g] of client.guilds.cache) {
        for (const [vId, tId] of Object.entries(MAPPINGS)) {
          if (tId && !sent.has(tId)) {
            const ch = g.channels.cache.get(tId);
            if (ch && ch.isTextBased()) {
              await ch.send(
                `📅 **Daily Check-in** — اضغط \`!checkin\` الآن لتسجل حضورك اليومي!`
              );
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

// ---------- Graceful shutdown ----------
process.on("SIGINT", () => {
  console.log("Shutting down...");
  // clear pending session timers
  for (const [, s] of activeSessions) {
    try {
      if (s.timeout) clearTimeout(s.timeout);
    } catch (e) {}
  }
  saveData();
  client.destroy();
  process.exit();
});

client.login(TOKEN);
