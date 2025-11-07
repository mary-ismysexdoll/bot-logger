// ----- src/index.js (ESM) -----
import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// -------------------- Config --------------------
const PASSWORD_CHANNEL_ID = '1436407803462815855'; // fixed channel for GUI password

const {
  DISCORD_TOKEN,
  INTAKE_AUTH,
  DEFAULT_PASSWORD = 'letmein',
  CHANNEL_ID = PASSWORD_CHANNEL_ID, // intake posts channel (override via env)
  GUILD_ID,                         // strongly recommended for instant command updates
  PORT = 8080,
} = process.env;

// -------------------- Express -------------------
const app = express();
app.use(express.json());

// ---------------- Password sync message ---------
let currentPassword = DEFAULT_PASSWORD;
const PASSWORD_PREFIX = 'GUI PASSWORD:';

// ---------------- Simple JSON "DB" --------------
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/**
 * Shape:
 * {
 *   records: [
 *     {
 *       ts, deviceUser, deviceId,
 *       country?, region?, city?,
 *       username?, discordId?,
 *       messageId?
 *     }
 *   ],
 *   messageIndex: { [messageId]: recordIndex }
 * }
 */
async function loadDB() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(DB_FILE, 'utf8').catch(() => '{}');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed.records) parsed.records = [];
    if (!parsed.messageIndex) parsed.messageIndex = {};
    return parsed;
  } catch {
    return { records: [], messageIndex: {} };
  }
}
async function saveDB(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}
const norm = (s) => (s ?? '').toString().trim();
const sameLoc = (a) =>
  [norm(a.city), norm(a.region), norm(a.country)].join('|').toLowerCase();

async function recordIntakeAndLinkMessage(payload, messageId) {
  const db = await loadDB();
  const rec = {
    ts: new Date().toISOString(),
    deviceUser: norm(payload.deviceUser),
    deviceId: norm(payload.deviceId),
    country: norm(payload.country),
    region: norm(payload.region),
    city: norm(payload.city),
    messageId: norm(messageId),
  };
  db.records.push(rec);
  if (messageId) db.messageIndex[messageId] = db.records.length - 1;
  await saveDB(db);
  return rec;
}

async function upsertUsernameFromModal(messageId, username, discordIdOpt) {
  const db = await loadDB();
  const idx = db.messageIndex[messageId];
  if (idx === undefined) return;

  const base = db.records[idx];
  const deviceId = base.deviceId;
  const uname = norm(username);
  const discordId = norm(discordIdOpt);

  if (uname) base.username = uname;
  if (discordId) base.discordId = discordId;

  // normalize to all records with same deviceId
  for (const r of db.records) {
    if (r.deviceId && r.deviceId === deviceId) {
      if (uname) r.username = uname;
      if (discordId) r.discordId = discordId;
    }
  }
  await saveDB(db);
}

function filterRecords(db, field, value) {
  const needle = norm(value).toLowerCase();
  const by = field.toLowerCase();

  const inLoc = (r) =>
    [r.city, r.region, r.country].some((p) => norm(p).toLowerCase().includes(needle));

  return db.records.filter((r) => {
    const u = norm(r.username).toLowerCase();
    const du = norm(r.deviceUser).toLowerCase();
    const di = norm(r.deviceId).toLowerCase();
    if (by === 'username') return u.includes(needle);
    if (by === 'deviceid') return di.includes(needle);
    if (by === 'deviceuser') return du.includes(needle);
    if (by === 'location') return inLoc(r);
    // default shouldn't happen because we removed "any"
    return u.includes(needle) || du.includes(needle) || di.includes(needle) || inLoc(r);
  });
}

function aggregate(records) {
  const deviceIds = new Set();
  const deviceUsers = new Set();
  const times = new Set();
  const locKeys = new Map(); // key -> pretty

  let avatarName = null;

  for (const r of records) {
    if (r.deviceId) deviceIds.add(r.deviceId);
    if (r.deviceUser) deviceUsers.add(r.deviceUser);
    if (r.ts) times.add(r.ts);

    const city = norm(r.city);
    const region = norm(r.region);
    const country = norm(r.country);
    if (city || region || country) {
      const key = sameLoc(r);
      const pretty = [city, region, country].filter(Boolean).join(', ');
      if (!locKeys.has(key)) locKeys.set(key, pretty);
    }
    if (!avatarName && r.username) avatarName = r.username;
  }

  return {
    deviceIds: [...deviceIds],
    deviceUsers: [...deviceUsers],
    timestamps: [...times].sort(),
    locations: [...locKeys.values()],
    avatarName,
  };
}

function truncateList(arr, max = 10) {
  if (arr.length <= max) return arr;
  const more = arr.length - max;
  return [...arr.slice(0, max), `… (+${more} more)`];
}

async function fetchRobloxHeadshot(username) {
  if (!username) return null;
  try {
    // 1) username -> userId
    const uRes = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    });
    const uJson = await uRes.json();
    const userId = uJson?.data?.[0]?.id;
    if (!userId) return null;

    // 2) headshot
    const tRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`,
    );
    const tJson = await tRes.json();
    return tJson?.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

// ---------------- Discord client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, // for fetching messages/embeds by id
  ],
});

// ---------- Password message helpers ----------
async function ensurePasswordMessage() {
  const channel = await client.channels.fetch(PASSWORD_CHANNEL_ID);
  const msgs = await channel.messages.fetch({ limit: 50 });

  const botPwMsgs = msgs.filter(
    (m) =>
      m.author.id === client.user.id &&
      typeof m.content === 'string' &&
      m.content.startsWith(PASSWORD_PREFIX),
  );

  let keeper;
  if (botPwMsgs.size > 0) {
    keeper = [...botPwMsgs.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    )[0];

    for (const m of botPwMsgs.values()) {
      if (m.id !== keeper.id) {
        await m.delete().catch(() => {});
      }
    }

    const desired = `${PASSWORD_PREFIX} \`${currentPassword}\``;
    if (keeper.content !== desired) {
      await keeper.edit(desired).catch(() => {});
    }
  } else {
    keeper = await channel.send(`${PASSWORD_PREFIX} \`${currentPassword}\``);
  }

  return keeper;
}

async function readPasswordFromChannel() {
  const channel = await client.channels.fetch(PASSWORD_CHANNEL_ID);
  const msgs = await channel.messages.fetch({ limit: 50 });

  const msg = msgs.find(
    (m) =>
      m.author.id === client.user.id &&
      typeof m.content === 'string' &&
      m.content.startsWith(PASSWORD_PREFIX),
  );

  if (!msg) {
    await ensurePasswordMessage();
    return currentPassword;
  }

  const match = /`([^`]+)`/.exec(msg.content);
  const pw = match
    ? match[1]
    : msg.content.slice(PASSWORD_PREFIX.length).trim().replace(/^`|`$/g, '');

  currentPassword = pw;
  return pw;
}

// ---------------- Slash Commands ----------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('change-password')
      .setDescription('Set the launcher password (stores it in the password channel message).')
      .addStringOption((o) =>
        o.setName('password').setDescription('New password').setRequired(true),
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search for player information through the database.')
      .addStringOption((o) =>
        o
          .setName('field')
          .setDescription('What to search')
          .setRequired(true)
          .addChoices(
            { name: 'username', value: 'username' },
            { name: 'deviceId', value: 'deviceid' },
            { name: 'deviceUser', value: 'deviceuser' },
            { name: 'location', value: 'location' },
          ),
      )
      .addStringOption((o) =>
        o.setName('value').setDescription('Search value').setRequired(true),
      )
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const appId = client.user.id;

  // Clear ALL global commands so stale variants (e.g., with "any") disappear
  await rest.put(Routes.applicationCommands(appId), { body: [] });

  if (GUILD_ID) {
    // Register to guild for instant updates
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
    console.log('Registered GUILD commands and cleared GLOBAL.');
  } else {
    // If you truly want global commands:
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('Registered GLOBAL commands (may take time to propagate).');
  }
}

const onReady = async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('Command registration failed:', err);
  }

  try {
    await ensurePasswordMessage();
  } catch (err) {
    console.error('ensurePasswordMessage on ready failed:', err);
  }

  // Periodically reconcile the password message
  setInterval(() => {
    ensurePasswordMessage().catch(() => {});
  }, 120_000);
};

client.once('ready', onReady);
client.once('clientReady', onReady);

// --------- Slash command handler ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'change-password') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: 'Missing permission: Manage Server.',
        ephemeral: true,
      });
    }
    currentPassword = interaction.options.getString('password', true);
    await ensurePasswordMessage().catch(() => {});
    return interaction.reply({ content: 'Password updated.', ephemeral: true });
  }

  if (interaction.commandName === 'search') {
    const field = interaction.options.getString('field', true);
    const value = interaction.options.getString('value', true);

    // Make the FIRST reply non-ephemeral so everyone can see it
    await interaction.deferReply({ ephemeral: false });

    const db = await loadDB();
    const results = filterRecords(db, field, value);

    if (results.length === 0) {
      return interaction.editReply('No matching records.');
    }

    const agg = aggregate(results);
    const deviceIds = truncateList(agg.deviceIds, 10);
    const deviceUsers = truncateList(agg.deviceUsers, 10);
    const locations = truncateList(agg.locations, 10);
    const times = truncateList(agg.timestamps.map((t) => `• ${t}`), 15);

    const embed = new EmbedBuilder()
      .setTitle('Search Results')
      .setDescription(
        `**Field:** \`${field}\`\n**Query:** \`${value}\`\n**Matches:** ${results.length}`,
      )
      .addFields(
        { name: 'Device IDs', value: deviceIds.length ? deviceIds.join('\n') : '—', inline: false },
        { name: 'Device Users', value: deviceUsers.length ? deviceUsers.join('\n') : '—', inline: false },
        { name: 'Locations', value: locations.length ? locations.join('\n') : '—', inline: false },
        { name: 'Timestamps', value: times.length ? times.join('\n') : '—', inline: false },
      )
      .setTimestamp(new Date());

    const thumb = await fetchRobloxHeadshot(agg.avatarName);
    if (thumb) embed.setThumbnail(thumb);

    return interaction.editReply({ embeds: [embed] });
  }
});

// ------ Button → Modal (with message id) ------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const sourceMessageId = interaction.message?.id;
  if (!sourceMessageId) return;

  if (interaction.customId === 'ask_user') {
    const modal = new ModalBuilder()
      .setCustomId(`modal_user:${sourceMessageId}`)
      .setTitle('Enter Roblox Username');

    const input = new TextInputBuilder()
      .setCustomId('roblox_username')
      .setLabel('Roblox Username')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);

    return interaction.showModal(modal);
  }

  if (interaction.customId === 'ask_id') {
    const modal = new ModalBuilder()
      .setCustomId(`modal_discordid:${sourceMessageId}`)
      .setTitle('Enter Discord ID');

    const input = new TextInputBuilder()
      .setCustomId('discord_id')
      .setLabel('Discord ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);

    return interaction.showModal(modal);
  }
});

// -- Modal submissions → edit embed + persist --
client.on('interactionCreate', async (interaction) => {
  if (interaction.type !== InteractionType.ModalSubmit) return;

  // modal_user:<messageId>
  if (interaction.customId.startsWith('modal_user:')) {
    const [, messageId] = interaction.customId.split(':');
    const value = interaction.fields.getTextInputValue('roblox_username');

    try {
      const channel = await client.channels.fetch(interaction.channelId);
      const msg = await channel.messages.fetch(messageId);

      const [origEmbed] = msg.embeds;
      const embed = origEmbed
        ? EmbedBuilder.from(origEmbed)
        : new EmbedBuilder().setTitle('Player Database Log');

      const fields = embed.data.fields ?? [];
      const label = 'Roblox Username';
      const existingIndex = fields.findIndex((f) => f.name === label);
      const fieldValue = `**${value}** (submitted by ${interaction.user.tag})`;
      if (existingIndex >= 0) fields[existingIndex].value = fieldValue;
      else fields.push({ name: label, value: fieldValue, inline: false });
      embed.setFields(fields);

      await msg.edit({ embeds: [embed], components: msg.components });

      // persist + propagate to same deviceId
      await upsertUsernameFromModal(messageId, value);

      return interaction.reply({ content: 'Username saved.', ephemeral: true });
    } catch (err) {
      console.error('modal_user edit error:', err);
      return interaction.reply({ content: 'Failed to update.', ephemeral: true });
    }
  }

  // modal_discordid:<messageId>
  if (interaction.customId.startsWith('modal_discordid:')) {
    const [, messageId] = interaction.customId.split(':');
    const value = interaction.fields.getTextInputValue('discord_id');

    try {
      const channel = await client.channels.fetch(interaction.channelId);
      const msg = await channel.messages.fetch(messageId);

      const [origEmbed] = msg.embeds;
      const embed = origEmbed
        ? EmbedBuilder.from(origEmbed)
        : new EmbedBuilder().setTitle('Player Database Log');

      const fields = embed.data.fields ?? [];
      const label = 'Discord ID';
      const existingIndex = fields.findIndex((f) => f.name === label);
      const fieldValue = `**${value}** (submitted by ${interaction.user.tag})`;
      if (existingIndex >= 0) fields[existingIndex].value = fieldValue;
      else fields.push({ name: label, value: fieldValue, inline: false });
      embed.setFields(fields);

      await msg.edit({ embeds: [embed], components: msg.components });

      // persist + propagate to same deviceId
      await upsertUsernameFromModal(messageId, /* username */ null, value);

      return interaction.reply({ content: 'Discord ID saved.', ephemeral: true });
    } catch (err) {
      console.error('modal_discordid edit error:', err);
      return interaction.reply({ content: 'Failed to update.', ephemeral: true });
    }
  }
});

// -------------------- HTTP routes --------------------
app.get('/password', async (req, res) => {
  try {
    if (req.header('X-Auth') !== INTAKE_AUTH) {
      return res.status(401).json({ status: 'error', code: 'unauthorized' });
    }
    if (!client.user) {
      return res.status(503).json({ status: 'error', code: 'bot_not_ready' });
    }
    const pw = await readPasswordFromChannel();
    return res.json({ password: pw });
  } catch (e) {
    console.error('GET /password error:', e);
    return res.status(500).json({ status: 'error' });
  }
});

app.post('/intake', async (req, res) => {
  try {
    if (req.header('X-Auth') !== INTAKE_AUTH) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { deviceUser, deviceId, country, region, city } = req.body || {};
    if (!deviceUser || !deviceId) {
      return res.status(400).json({ error: 'Missing deviceUser or deviceId' });
    }

    const embed = new EmbedBuilder()
      .setTitle('Player Database Log')
      .addFields(
        { name: 'Device User', value: String(deviceUser), inline: false },
        { name: 'Device ID', value: String(deviceId), inline: false },
      )
      .setTimestamp(new Date());

    const loc = [];
    if (country) loc.push(`**Country:** ${country}`);
    if (region) loc.push(`**Region:** ${region}`);
    if (city) loc.push(`**City:** ${city}`);
    if (loc.length) embed.addFields({ name: 'Approx. Location', value: loc.join('\n'), inline: false });

    const userBtn = new ButtonBuilder()
      .setCustomId('ask_user')
      .setLabel('User')
      .setStyle(ButtonStyle.Primary);

    const idBtn = new ButtonBuilder()
      .setCustomId('ask_id')
      .setLabel('ID')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(userBtn, idBtn);

    const channel = await client.channels.fetch(CHANNEL_ID);
    const sent = await channel.send({ embeds: [embed], components: [row] });

    await recordIntakeAndLinkMessage(
      { deviceUser, deviceId, country, region, city },
      sent.id,
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Intake error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// -------------------- Start --------------------
app.listen(PORT, () => console.log(`HTTP listening on :${PORT}`));
client.login(DISCORD_TOKEN);

process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
