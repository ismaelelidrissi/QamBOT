// Qambot.js (ESM-ready) — QamBOT with 3 features: Daily Checkin, XP, Anti-Procrastination
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

    // schedule daily checkin at 09:00 server time
    scheduleDailyCheckin(9, 0);
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

// ---------- messageCreate (improved: commands + leo detection) ----------
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    const content = (message.content || "").trim();

    // --- Commands (prefix !) available to everyone ---
    if (content.startsWith("!")) {
      const parts = content.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === "checkin") {
        const uid = message.author.id;
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const u = ensureUser(uid);
        if (u.lastCheckinDate === today) {
          await message.reply("✅ أنت سجلت حضورك لهذا اليوم بالفعل.");
        } else {
          // check if consecutive
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
      // other commands can be added here
    }

    // --- If leoBotId set: require message from it, otherwise allow mention parsing ---
    if (LEO_BOT_ID && message.author.id !== LEO_BOT_ID) {
      // if leo id set but message is not from leo, still allow commands above; so return
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

    // 2) fallback keyword detection
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

// ---------- voiceStateUpdate for break monitoring ----------
client.on("voiceStateUpdate", (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const oldChan = oldState.channel;
    const newChan = newState.channel;

    // left a channel
    if (oldChan && (!newChan || newChan.id !== oldChan.id)) {
      // if left a break channel cancel existing timeout
      if (isBreakChannel(oldChan)) {
        const key = `${member.id}_${oldChan.id}`;
        const t = breakStayTimeouts.get(key);
        if (t) {
          clearTimeout(t);
          breakStayTimeouts.delete(key);
        }
      }
    }

    // joined a channel
    if (newChan && (!oldChan || oldChan.id !== newChan.id)) {
      if (isBreakChannel(newChan)) {
        recordBreakJoin(member.id);
        // set a 15-min reminder if still in the channel
        const key = `${member.id}_${newChan.id}`;
        const t = setTimeout(async () => {
          try {
            const freshMem = await newState.guild.members.fetch(member.id);
            if (freshMem.voice && freshMem.voice.channelId === newChan.id) {
              await freshMem.send(
                `Hey ${freshMem.user.username}, يبدو أنك في البريك أكثر من 15 دقيقة. هل تريد الرجوع للدراسة؟ 💪`
              );
              // record as potential procrastination
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
  // keep only last 1 hour entries
  u.breakJoins = u.breakJoins.filter((t) => now - t < 60 * 60 * 1000);
  u.breakJoins.push(now);
  saveData();

  // if more than 3 joins in last hour => send DM warning
  const recent = u.breakJoins.filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 3) {
    // try sending DM later (must fetch guild member)
    // We can't DM directly here (no ctx), but attempt:
    (async () => {
      try {
        // find guilds where member exists
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

// ---------- handleStartFocus (mostly unchanged) ----------
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
            // record infraction and maybe reduce XP or mark them
            addInfraction(id);
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

// ---------- Interaction handler (mark present and award XP) ----------
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

    // mark present and award XP
    session.present.add(memberId);
    session.waiting.delete(memberId);
    // award XP for pressing present
    addXP(memberId, 10);
    await interaction.reply({
      content: "✅ Marked present — you earned **10 XP**! Good luck!",
      ephemeral: true,
    });
  } catch (err) {
    console.error("Interaction handler error", err);
  }
});

// ---------- helper: scheduling daily checkin ----------
function scheduleDailyCheckin(hour = 9, minute = 0) {
  try {
    // compute next occurrence
    const now = new Date();
    let next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const msUntil = next - now;
    setTimeout(() => {
      doDailyCheckin();
      // schedule every 24h
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
    if (DATA.lastDailyAt === today) {
      return; // already done today
    }
    DATA.lastDailyAt = today;
    saveData();

    // send message to configured channel or all mapping text channels
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
      // fallback: send to all mapped text channels
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
  saveData();
  client.destroy();
  process.exit();
});

client.login(TOKEN);
