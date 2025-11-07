import 'dotenv/config';
import express from 'express';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  PORT = 3000,
  INTAKE_AUTH,
} = process.env;

if (!DISCORD_TOKEN || !CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN or CHANNEL_ID in env.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

/** Builds the intake embed + buttons */
function buildIntake(deviceUser, deviceId) {
  const embed = new EmbedBuilder()
    .setTitle('Checker Intake')
    .setColor(0xFFD700) // gold-ish
    .addFields(
      { name: 'Device Username', value: String(deviceUser || 'unknown'), inline: false },
      { name: 'Device ID', value: String(deviceId || 'unknown'), inline: false },
    )
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_user_modal')
      .setLabel('User')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🟡'),
    new ButtonBuilder()
      .setCustomId('btn_id_modal')
      .setLabel('ID')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⚪'),
  );

  return { embed, row };
}

/** HTTP server to receive posts from the PowerShell script */
const app = express();
app.use(express.json());

app.post('/intake', async (req, res) => {
  try {
    // simple shared-secret header (optional but recommended)
    if (INTAKE_AUTH) {
      const auth = req.header('X-Auth');
      if (auth !== INTAKE_AUTH) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
    }

    const { deviceUser, deviceId } = req.body || {};
    if (!deviceUser || !deviceId) {
      return res.status(400).json({ ok: false, error: 'deviceUser and deviceId required' });
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ ok: false, error: 'CHANNEL_ID is not a text channel' });
    }

    const { embed, row } = buildIntake(deviceUser, deviceId);
    const msg = await channel.send({ embeds: [embed], components: [row] });

    return res.json({ ok: true, messageId: msg.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

/** Handle button clicks -> open modals; handle modal submits -> edit the embed */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Buttons -> show modals
    if (interaction.isButton()) {
      if (interaction.customId === 'btn_user_modal') {
        const modal = new ModalBuilder()
          .setCustomId('user_modal')
          .setTitle('Enter Roblox Username');

        const input = new TextInputBuilder()
          .setCustomId('roblox_username')
          .setLabel('Roblox Username')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'btn_id_modal') {
        const modal = new ModalBuilder()
          .setCustomId('discordid_modal')
          .setTitle('Enter Discord ID');

        const input = new TextInputBuilder()
          .setCustomId('discord_id')
          .setLabel('Discord ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(25);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        return interaction.showModal(modal);
      }
      return;
    }

    // Modals -> update the message embed
    if (interaction.isModalSubmit()) {
      const msg = interaction.message; // original message with the embed/buttons
      if (!msg) {
        await interaction.reply({ content: 'Could not locate the message.', ephemeral: true });
        return;
      }

      const original = msg.embeds?.[0];
      if (!original) {
        await interaction.reply({ content: 'No embed to update.', ephemeral: true });
        return;
      }

      // Rebuild the embed from the original and append new field
      const updated = EmbedBuilder.from(original);

      if (interaction.customId === 'user_modal') {
        const roblox = interaction.fields.getTextInputValue('roblox_username').trim();
        updated.addFields({ name: 'Roblox User', value: roblox || 'n/a', inline: false });
        await msg.edit({ embeds: [updated] });
        await interaction.reply({ content: 'Roblox username saved.', ephemeral: true });
        return;
      }

      if (interaction.customId === 'discordid_modal') {
        const discId = interaction.fields.getTextInputValue('discord_id').trim();
        updated.addFields({ name: 'Discord ID', value: discId || 'n/a', inline: false });
        await msg.edit({ embeds: [updated] });
        await interaction.reply({ content: 'Discord ID saved.', ephemeral: true });
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
app.listen(Number(PORT), () => {
  console.log(`HTTP intake listening on :${PORT}`);
});
