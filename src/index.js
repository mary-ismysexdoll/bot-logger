// src/index.js (ESM)
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
  CHANNEL_ID,
  INTAKE_AUTH,
  DEFAULT_PASSWORD = 'letmein',
  GUILD_ID, // optional: instant command registration if provided
  PORT,
} = process.env;

let currentPassword = DEFAULT_PASSWORD;

const app = express();
app.use(express.json());

// ---- REST: intake (from PowerShell launcher)
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

    const gold = new ButtonBuilder()
      .setCustomId('ask_user')
      .setLabel('User')
      .setStyle(ButtonStyle.Primary);

    const silver = new ButtonBuilder()
      .setCustomId('ask_id')
      .setLabel('ID')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(gold, silver);

    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send({ embeds: [embed], components: [row] });

    return res.json({ ok: true });
  } catch (e) {
    console.error('intake error', e);
    return res.status(500).json({ status: 'error' });
  }
});

// ---- REST: read current password (used by launcher)
app.get('/password', (req, res) => {
  if (req.header('X-Auth') !== INTAKE_AUTH) {
    return res.status(401).json({ status: 'error', code: 'unauthorized' });
  }
  return res.json({ password: currentPassword });
});

// ---- Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const commands = [
      new SlashCommandBuilder()
        .setName('change-password')
        .setDescription('Set the launcher password (stored in bot memory).')
        .addStringOption(o =>
          o.setName('password').setDescription('New password').setRequired(true),
        )
        .toJSON(),
    ];

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, GUILD_ID)
      : Routes.applicationCommands(client.user.id);

    await rest.put(route, { body: commands });
    console.log('Bot ready. Current password:', currentPassword, 'Scope:', GUILD_ID ? `guild ${GUILD_ID}` : 'global');
  } catch (err) {
    console.error('Command registration failed:', err);
  }
});

// ---- Slash command handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'change-password') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'Missing permission: Manage Server.', ephemeral: true });
    }
    currentPassword = interaction.options.getString('password', true);
    return interaction.reply({ content: `Password set to: \`${currentPassword}\`` });
  }
});

// ---- Buttons -> show modals for Roblox user / Discord ID
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'ask_user') {
    const modal = new ModalBuilder()
      .setCustomId('modal_user')
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
      .setCustomId('modal_discordid')
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

// ---- Handle modal submissions
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

// ---- Start web + login bot
const port = Number(PORT) || 3000;
app.listen(port, () => console.log(`HTTP intake listening on :${port}`));
client.login(DISCORD_TOKEN);
