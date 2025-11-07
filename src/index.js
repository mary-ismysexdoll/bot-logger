// index.js (ESM)
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

const {
  DISCORD_TOKEN,
  INTAKE_AUTH,
  DEFAULT_PASSWORD = 'letmein',
  CHANNEL_ID,
  PORT = 8080,

  // GitHub settings
  GITHUB_TOKEN,
  GITHUB_REPO,          // "owner/name"
  GITHUB_FILE_PATH = 'password.txt',
  GITHUB_BRANCH = 'main',
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO || !CHANNEL_ID) {
  console.error('Missing required env: GITHUB_TOKEN, GITHUB_REPO, CHANNEL_ID');
  process.exit(1);
}

const app = express();
app.use(express.json());
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const PASSWORD_PREFIX = 'GUI PASSWORD:';

// ---------- GitHub helpers ----------
const ghBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_FILE_PATH)}`;

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'checker-intake-bot',
    'Content-Type': 'application/json',
  };
}

async function githubGetFile() {
  const url = `${ghBase}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json(); // { content, encoding, sha, ... }
}

async function githubPutFile(newText, sha /* optional when creating */) {
  const url = ghBase;
  const body = {
    message: `Update GUI password`,
    content: Buffer.from(newText, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  };
  const r = await fetch(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PUT ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function ensurePasswordFile() {
  const existing = await githubGetFile();
  if (!existing) {
    await githubPutFile(`${DEFAULT_PASSWORD}\n`);
    return DEFAULT_PASSWORD;
  }
  const buf = Buffer.from(existing.content, 'base64').toString('utf8');
  const pw = buf.split(/\r?\n/)[0].trim();
  return pw || DEFAULT_PASSWORD;
}

async function readPasswordFromRepo() {
  const existing = await githubGetFile();
  if (!existing) return DEFAULT_PASSWORD;
  const buf = Buffer.from(existing.content, 'base64').toString('utf8');
  return buf.split(/\r?\n/)[0].trim();
}

async function writePasswordToRepo(newPw) {
  const existing = await githubGetFile();
  if (existing) {
    await githubPutFile(`${newPw}\n`, existing.sha);
  } else {
    await githubPutFile(`${newPw}\n`);
  }
}

// ---------- Discord projection (one message shows current pw) ----------
async function ensurePasswordMessage() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const msgs = await channel.messages.fetch({ limit: 50 });
  const pw = await readPasswordFromRepo();

  const mine = msgs.filter(
    (m) => m.author.id === client.user.id && m.content?.startsWith(PASSWORD_PREFIX)
  );
  let keeper = mine.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first();

  if (!keeper) {
    keeper = await channel.send(`${PASSWORD_PREFIX} \`${pw}\``);
  } else {
    const desired = `${PASSWORD_PREFIX} \`${pw}\``;
    if (keeper.content !== desired) await keeper.edit(desired).catch(() => {});
    // delete dupes
    for (const m of mine.values()) if (m.id !== keeper.id) await m.delete().catch(() => {});
  }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('change-password')
      .setDescription('Set the launcher password (writes to GitHub).')
      .addStringOption((o) => o.setName('password').setDescription('New password').setRequired(true))
      .toJSON(),
  ];
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('Registered GLOBAL commands (may take time to appear).');
}

const onReady = async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands().catch(console.error);
  await ensurePasswordFile().catch(console.error);
  await ensurePasswordMessage().catch(console.error);
  setInterval(() => ensurePasswordMessage().catch(() => {}), 120_000);
};

client.once('ready', onReady);
client.once('clientReady', onReady);

// Slash command -> update repo + projection
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'change-password') return;

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({ content: 'Missing permission: Manage Server.', ephemeral: true });
  }

  const newPw = interaction.options.getString('password', true);
  try {
    await writePasswordToRepo(newPw);
    await ensurePasswordMessage();
    await interaction.reply({ content: 'Password updated.', ephemeral: true });
  } catch (e) {
    console.error('change-password error', e);
    await interaction.reply({ content: 'Failed to update password file.', ephemeral: true });
  }
});

// Buttons / modals (unchanged helpers)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'ask_user') {
    const modal = new ModalBuilder().setCustomId('modal_user').setTitle('Enter Roblox Username');
    const input = new TextInputBuilder().setCustomId('roblox_username').setLabel('Roblox Username').setStyle(TextInputStyle.Short).setRequired(true);
    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'ask_id') {
    const modal = new ModalBuilder().setCustomId('modal_discordid').setTitle('Enter Discord ID');
    const input = new TextInputBuilder().setCustomId('discord_id').setLabel('Discord ID').setStyle(TextInputStyle.Short).setRequired(true);
    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);
    return interaction.showModal(modal);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.type !== InteractionType.ModalSubmit) return;

  if (interaction.customId === 'modal_user') {
    const value = interaction.fields.getTextInputValue('roblox_username');
    return interaction.reply({ content: `User: **${value}** (submitted by ${interaction.user.tag})` });
  }

  if (interaction.customId === 'modal_discordid') {
    const value = interaction.fields.getTextInputValue('discord_id');
    return interaction.reply({ content: `ID: **${value}** (submitted by ${interaction.user.tag})` });
  }
});

// ---------- HTTP (GUI can call this if you prefer JSON) ----------
app.get('/password', async (req, res) => {
  try {
    if (req.header('X-Auth') !== INTAKE_AUTH) return res.status(401).json({ status: 'error', code: 'unauthorized' });
    const pw = await readPasswordFromRepo();
    res.json({ password: pw });
  } catch (e) {
    console.error('GET /password error', e);
    res.status(500).json({ status: 'error' });
  }
});

app.post('/intake', async (req, res) => {
  try {
    if (req.header('X-Auth') !== INTAKE_AUTH) return res.status(401).json({ status: 'error', code: 'unauthorized' });
    const { deviceUser, deviceId } = req.body || {};
    if (!deviceUser || !deviceId) return res.status(400).json({ status: 'error', code: 'bad_body' });

    const embed = new EmbedBuilder()
      .setTitle('Checker Intake')
      .addFields(
        { name: 'Device User', value: String(deviceUser), inline: false },
        { name: 'Device ID', value: String(deviceId), inline: false },
      )
      .setTimestamp(new Date());

    const gold = new ButtonBuilder().setCustomId('ask_user').setLabel('User').setStyle(ButtonStyle.Primary);
    const silver = new ButtonBuilder().setCustomId('ask_id').setLabel('ID').setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(gold, silver);

    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send({ embeds: [embed], components: [row] });

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /intake error', e);
    res.status(500).json({ status: 'error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`HTTP listening on :${PORT}`));
client.login(DISCORD_TOKEN);

process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
