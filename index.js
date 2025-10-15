import { Client, GatewayIntentBits, Collection, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Simple in-memory storage
const appointments = new Map();

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'appointment') {
      await handleAppointmentCommand(interaction);
    }
  } else if (interaction.isButton()) {
    await handleButtonClick(interaction);
  }
});

async function handleAppointmentCommand(interaction) {
  try {
    const game = interaction.options.getString('game');
    const partySize = interaction.options.getInteger('party_size');
    const timeInput = interaction.options.getString('time');
    
    // Parse time
    let appointmentTime;
    if (timeInput.startsWith('in ')) {
      const minutes = parseInt(timeInput.replace('in ', '').replace(' minutes', '').replace(' minute', ''));
      appointmentTime = new Date(Date.now() + minutes * 60000);
    } else {
      const [hours, minutes] = timeInput.split(':').map(Number);
      appointmentTime = new Date();
      appointmentTime.setHours(hours, minutes, 0, 0);
      if (appointmentTime <= new Date()) {
        appointmentTime.setDate(appointmentTime.getDate() + 1);
      }
    }
    
    if (appointmentTime <= new Date()) {
      await interaction.reply({ content: '❌ Time must be in the future!', ephemeral: true });
      return;
    }
    
    // Create embed
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎮 Game Appointment')
      .addFields(
        { name: 'Game', value: game, inline: true },
        { name: 'Party Size', value: `0/${partySize}`, inline: true },
        { name: 'Time', value: appointmentTime.toLocaleString(), inline: true },
        { name: 'Participants', value: 'None yet', inline: false }
      );
    
    // Create buttons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('join')
          .setLabel('Join')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('leave')
          .setLabel('Leave')
          .setStyle(ButtonStyle.Danger)
      );
    
    await interaction.reply({ embeds: [embed], components: [row] });
    
    // Fetch the actual message to get the correct ID
    const message = await interaction.fetchReply();
    
    // Store appointment using the message ID
    appointments.set(message.id, {
      game,
      partySize,
      time: appointmentTime,
      participants: [],
      channelId: interaction.channelId
    });
    
    console.log(`Stored appointment with message ID: ${message.id}`);
    
  } catch (error) {
    console.error('Error in appointment command:', error);
    await interaction.reply({ content: '❌ Error creating appointment!', ephemeral: true });
  }
}

async function handleButtonClick(interaction) {
  try {
    console.log(`Looking for appointment with message ID: ${interaction.message.id}`);
    console.log(`Available appointments:`, Array.from(appointments.keys()));
    
    const appointment = appointments.get(interaction.message.id);
    if (!appointment) {
      await interaction.reply({ content: '❌ Appointment not found!', ephemeral: true });
      return;
    }
    
    const userId = interaction.user.id;
    const isJoining = interaction.customId === 'join';
    
    let responseMessage = '';
    
    if (isJoining) {
      if (appointment.participants.includes(userId)) {
        await interaction.reply({ content: '⚠️ You already joined!', ephemeral: true });
        return;
      }
      appointment.participants.push(userId);
      responseMessage = '✅ You joined the appointment!';
    } else {
      if (!appointment.participants.includes(userId)) {
        await interaction.reply({ content: '⚠️ You are not in this appointment!', ephemeral: true });
        return;
      }
      appointment.participants = appointment.participants.filter(id => id !== userId);
      responseMessage = '❌ You left the appointment!';
    }
    
    // Update the message with new participant list
    const participantList = appointment.participants.length > 0 
      ? appointment.participants.map(id => `<@${id}>`).join(', ')
      : 'None yet';
    
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎮 Game Appointment')
      .addFields(
        { name: 'Game', value: appointment.game, inline: true },
        { name: 'Party Size', value: `${appointment.participants.length}/${appointment.partySize}`, inline: true },
        { name: 'Time', value: appointment.time.toLocaleString(), inline: true },
        { name: 'Participants', value: participantList, inline: false }
      );
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('join')
          .setLabel('Join')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('leave')
          .setLabel('Leave')
          .setStyle(ButtonStyle.Danger)
      );
    
    // Update the original message and send response
    await interaction.update({ embeds: [embed], components: [row] });
    await interaction.followUp({ content: responseMessage, ephemeral: true });
    
  } catch (error) {
    console.error('Error handling button click:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Error processing request!', ephemeral: true });
      }
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);