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

  // Channel that must always contain exactly ONE password message
  CHANNEL_ID = '1436407803462815855',

  // Optional: instant command registration for a single guild
  GUILD_ID,
  PORT = 3000,
} = process.env;

let currentPassword = DEFAULT_PASSWORD;

// ---------- HTTP app ----------
const app = express();
app.use(express.json());

// PowerShell launcher reads the password here
app.get('/password', (req, res) => {
  if (req.header('X-Auth') !== INTAKE_AUTH) {
    return res.status(401).json({ status: 'error', code: 'unauthorized' });
  }
  return res.json({ password: currentPassword });
});

// Intake endpoint used by your .ps1 "Log" button
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
    console.error('intake error', e);
    return res.status(500).json({ status: 'error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Discord client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Single-password-message enforcement
const PASSWORD_PREFIX = 'GUI PASSWORD:';

async function ensurePasswordMessage() {
  const channel = await client.channels.fetch(CHANNEL_ID);

  // Fetch recent messages, find bot-authored password messages
  const msgs = await channel.messages.fetch({ limit: 50 });
  const botPwMsgs = msgs.filter(
    (m) => m.author.id === client.user.id && typeof m.content === 'string' && m.content.startsWith(PASSWORD_PREFIX)
  );

  let keeper;
  if (botPwMsgs.size > 0) {
    // Keep the newest; delete the rest
    keeper = [...botPwMsgs.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    for (const m of botPwMsgs.values()) {
      if (m.id !== keeper.id) {
        await m.delete().catch(() => {});
      }
    }
    // Update text if password changed
    const desired = `${PASSWORD_PREFIX} \`${currentPassword}\``;
    if (keeper.content !== desired) {
      await keeper.edit(desired);
    }
  } else {
    // Post the one and only password message
    keeper = await channel.send(`${PASSWORD_PREFIX} \`${currentPassword}\``);
  }
  return keeper;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Upsert slash command(s)
  const commands = [
    new SlashCommandBuilder()
      .setName('change-password')
      .setDescription('Set the launcher password (stored in memory and shown in the channel).')
      .addStringOption((o) => o.setName('password').setDescription('New password').setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
      console.log('Registered GUILD commands for fast availability.');
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('Registered GLOBAL commands (may take time to appear).');
    }
  } catch (err) {
    console.error('Command registration failed:', err);
  }

  // Make sure the channel has exactly one password message at boot
  try {
    await ensurePasswordMessage();
  } catch (err) {
    console.error('ensurePasswordMessage on ready failed:', err);
  }

  // Periodic reconciliation (keeps exactly one message, updates if needed)
  setInterval(() => {
    ensurePasswordMessage().catch(() => {});
  }, 120_000);
});

// Slash command handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'change-password') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Missing permission: Manage Server.', ephemeral: true });
    }
    currentPassword = interaction.options.getString('password', true);
    await ensurePasswordMessage().catch(() => {});
    return interaction.reply({ content: 'Password updated and channel message refreshed.', ephemeral: true });
  }
});

// Buttons -> show modals (unchanged behavior)
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

// ---------- Start ----------
app.listen(PORT, () => console.log(`HTTP listening on :${PORT}`));
client.login(DISCORD_TOKEN);

// Helpful logging
process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
