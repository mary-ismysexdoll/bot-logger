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
  CHANNEL_ID = '1436407803462815855',
  GUILD_ID,
  PORT = 8080,
} = process.env;

const app = express();
app.use(express.json());

let currentPassword = DEFAULT_PASSWORD;
const PASSWORD_PREFIX = 'GUI PASSWORD:';

// ---------- Discord client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Keep exactly one password message in the channel
async function ensurePasswordMessage() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const msgs = await channel.messages.fetch({ limit: 50 });

  const botPwMsgs = msgs.filter(
    (m) => m.author.id === client.user.id && typeof m.content === 'string' && m.content.startsWith(PASSWORD_PREFIX)
  );

  let keeper;
  if (botPwMsgs.size > 0) {
    keeper = [...botPwMsgs.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
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

// Parse the password from the single channel message (source of truth)
async function readPasswordFromChannel() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const msgs = await channel.messages.fetch({ limit: 50 });
  const msg = msgs.find(
    (m) => m.author.id === client.user.id && typeof m.content === 'string' && m.content.startsWith(PASSWORD_PREFIX)
  );

  if (!msg) {
    // If nothing exists yet, create it with currentPassword
    await ensurePasswordMessage();
    return currentPassword;
  }
  const m = /`([^`]+)`/.exec(msg.content);
  const pw = m ? m[1] : msg.content.slice(PASSWORD_PREFIX.length).trim().replace(/^`|`$/g, '');
  currentPassword = pw; // keep in sync
  return pw;
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('change-password')
      .setDescription('Set the launcher password (writes it into the channel message).')
      .addStringOption((o) => o.setName('password').setDescription('New password').setRequired(true))
      .toJSON(),
  ];
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('Registered GUILD commands (instant).');
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Registered GLOBAL commands (may take time).');
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
    // Seed the channel message with DEFAULT_PASSWORD on boot (or keep the existing one)
    await ensurePasswordMessage();
  } catch (err) {
    console.error('ensurePasswordMessage on ready failed:', err);
  }
  // Periodic reconciliation
  setInterval(() => {
    ensurePasswordMessage().catch(() => {});
  }, 120_000);
};

// Support both current and upcoming event name
client.once('ready', onReady);
client.once('clientReady', onReady);

// Slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'change-password') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Missing permission: Manage Server.', ephemeral: true });
    }
    currentPassword = interaction.options.getString('password', true);
    await ensurePasswordMessage().catch(() => {});
    return interaction.reply({ content: 'Password updated.', ephemeral: true });
  }
});

// Buttons → modals (unchanged)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'ask_user') {
    const modal = new ModalBuilder().setCustomId('modal_user').setTitle('Enter Roblox Username');
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
    const modal = new ModalBuilder().setCustomId('modal_discordid').setTitle('Enter Discord ID');
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

// Modal submissions
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

// ---------- HTTP routes ----------
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
      return res.status(401).json({ status: 'error', code: 'unauthorized' });
    }
    const { deviceUser, deviceId } = req.body || {};
    if (!deviceUser || !deviceId) {
      return res.status(400).json({ status: 'error', code: 'bad_body' });
    }

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

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /intake error:', e);
    return res.status(500).json({ status: 'error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Start ----------
app.listen(PORT, () => console.log(`HTTP listening on :${PORT}`));
client.login(DISCORD_TOKEN);

// Safety logging
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
