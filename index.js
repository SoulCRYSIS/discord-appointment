import { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import cron from 'node-cron';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy-key'
});

// Name mapping: Discord username -> Real name (for insults)
const nameMapping = {
  'soulcrysis': 'โอม',
  'palmatius': 'ปาม',
  'book0491': 'โบ้',
  'punhkao': 'โอม',
  'nailonely': 'นิสิตเลิฟเวอร์',
  'nowano4609': 'นน',
  'nonp4w1t': 'นนปวิท',
};

const divider = '--------------------------------';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ]
});

// Simple in-memory storage
const appointments = new Map();

// Persistent storage for user statistics
const STATS_FILE = path.join(process.cwd(), 'data', 'user-stats.json');
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = fs.readFileSync(STATS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading stats:', error);
  }
  return {};
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error('Error saving stats:', error);
  }
}

let userStats = loadStats(); // { userId: { totalWastedMinutes: 0, incidents: [], weeklyWaste: 0, monthlyWaste: 0 } }

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);

  // Start the appointment reminder scheduler
  startAppointmentScheduler();

  // Setup console commands
  await setupConsoleCommands();
});

// Listen for voice state changes (when users join/leave voice channels)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const userId = newState.id;

    // Check if user joined a voice channel
    if (!oldState.channel && newState.channel) {
      console.log(`🎤 User ${newState.member.user.username} joined voice channel: ${newState.channel.name}`);

      // Check all active appointments
      for (const [messageId, appointment] of appointments.entries()) {
        // If this user is a participant and hasn't been marked present yet
        if (appointment.participants.includes(userId) && !appointment.presentUsers.includes(userId)) {
          // Check if appointment time has passed
          const now = new Date();
          if (now >= new Date(appointment.time)) {
            appointment.presentUsers.push(userId);
            appointment.joinTimes[userId] = new Date().toISOString();
            console.log(`✅ Marked ${newState.member.user.username} as present for ${appointment.game}`);

            // Check if everyone is present AND party is full
            if (appointment.presentUsers.length === appointment.participants.length &&
              appointment.participants.length >= appointment.partySize) {
              console.log('🎉 All participants are present and party is full! Showing leaderboard...');

              const channel = await client.channels.fetch(appointment.channelId);
              if (channel && channel.isTextBased()) {
                const fakeInteraction = {
                  client,
                  guildId: appointment.guildId,
                  editReply: async (options) => {
                    await channel.send(options);
                  }
                };
                await showLeaderboard(fakeInteraction, appointment);
                appointments.delete(messageId);
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in voice state update:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'chronopact') {
        // Check if already deferred/replied to prevent double-defer
        if (!interaction.deferred && !interaction.replied) {
          try {
            await interaction.deferReply();
          } catch (err) {
            console.error('Failed to defer command interaction:', err);
            return; // Don't continue if defer failed
          }
        }
        await handleAppointmentCommand(interaction);
      } else if (interaction.commandName === 'wasteboard') {
        // Check if already deferred/replied to prevent double-defer
        if (!interaction.deferred && !interaction.replied) {
          try {
            await interaction.deferReply();
          } catch (err) {
            console.error('Failed to defer wasteboard interaction:', err);
            return;
          }
        }
        await handleWasteboardCommand(interaction);
      } else if (interaction.commandName === 'waitboard') {
        // Check if already deferred/replied to prevent double-defer
        if (!interaction.deferred && !interaction.replied) {
          try {
            await interaction.deferReply();
          } catch (err) {
            console.error('Failed to defer waitboard interaction:', err);
            return;
          }
        }
        await handleWaitboardCommand(interaction);
      }
    } else if (interaction.isButton()) {
      // Defer IMMEDIATELY before calling handler
      // Check if already deferred/replied to prevent double-defer
      if (!interaction.deferred && !interaction.replied) {
        try {
          await interaction.deferUpdate();
        } catch (err) {
          console.error('Failed to defer button interaction:', err);
          return;
        }
      }
      await handleButtonClick(interaction);
    }
  } catch (error) {
    console.error('Error in interaction handler:', error);
  }
});

async function handleAppointmentCommand(interaction) {
  try {
    // Already deferred in the main handler
    const game = interaction.options.getString('game');
    const partySize = interaction.options.getInteger('party_size');
    const timeInput = interaction.options.getString('time');

    // Parse time
    let appointmentTime;
    if (timeInput.startsWith('in ')) {
      const timeStr = timeInput.replace('in ', '');

      // Check if it's seconds
      if (timeStr.includes('second')) {
        const seconds = parseInt(timeStr.replace(' seconds', '').replace(' second', ''));
        appointmentTime = new Date(Date.now() + seconds * 1000);
      }
      // Check if it's minutes
      else {
        const minutes = parseInt(timeStr.replace(' minutes', '').replace(' minute', ''));
        appointmentTime = new Date(Date.now() + minutes * 60000);
      }
    } else {
      const [hours, minutes] = timeInput.split(':').map(Number);
      appointmentTime = new Date();
      appointmentTime.setHours(hours, minutes, 0, 0);
      if (appointmentTime <= new Date()) {
        appointmentTime.setDate(appointmentTime.getDate() + 1);
      }
    }

    if (appointmentTime <= new Date()) {
      await interaction.editReply({ content: '❌ Time must be in the future!' });
      return;
    }

    // Create embed
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎮 Game Appointment')
      .addFields(
        { name: 'Game', value: game, inline: true },
        { name: 'Party Size', value: `0/${partySize}`, inline: true },
        {
          name: 'Time', value: appointmentTime.toLocaleString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          }), inline: true
        },
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
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

    // Edit the deferred reply with the appointment
    const message = await interaction.editReply({ embeds: [embed], components: [row] });

    // Store appointment using the message ID
    appointments.set(message.id, {
      game,
      partySize,
      time: appointmentTime,
      participants: [],
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      shameChecks: { '5min': false, '10min': false, '15min': false, '30min': false, '45min': false, '60min': false },
      presentUsers: [], // Track users who have shown up in voice
      joinTimes: {}, // Track when each user joined voice { userId: timestamp }
      cancelled: false
    });

    console.log(`Stored appointment with message ID: ${message.id}`);

  } catch (error) {
    console.error('Error in appointment command:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Error creating appointment!' }).catch(() => { });
      }
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

async function handleButtonClick(interaction) {
  try {
    // Already deferred in the main handler
    console.log(`Looking for appointment with message ID: ${interaction.message.id}`);
    console.log(`Available appointments:`, Array.from(appointments.keys()));

    const appointment = appointments.get(interaction.message.id);
    if (!appointment) {
      await interaction.followUp({ content: '❌ Appointment not found!', ephemeral: true });
      return;
    }

    const userId = interaction.user.id;
    const customId = interaction.customId;

    let responseMessage = '';

    if (customId === 'cancel') {
      // Only allow cancellation by participants
      if (!appointment.participants.includes(userId)) {
        await interaction.followUp({ content: '⚠️ Only participants can cancel!', ephemeral: true });
        return;
      }

      appointment.cancelled = true;

      // Only show leaderboard if at least one person joined voice
      if (Object.keys(appointment.joinTimes).length > 0) {
        await showLeaderboard(interaction, appointment);
      } else {
        // Just show cancellation message
        const embed = new EmbedBuilder()
          .setColor('#808080')
          .setTitle('❌ Appointment Cancelled')
          .setDescription(`**${appointment.game}** appointment has been cancelled.`)
          .addFields({ name: 'Reason', value: 'No one joined voice channel' })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed], components: [] });
      }

      appointments.delete(interaction.message.id);
      return;

    } else if (customId === 'join') {
      if (appointment.participants.includes(userId)) {
        await interaction.followUp({ content: '⚠️ You already joined!', ephemeral: true });
        return;
      }
      appointment.participants.push(userId);
      responseMessage = '';
    } else if (customId === 'leave') {
      if (!appointment.participants.includes(userId)) {
        await interaction.followUp({ content: '⚠️ You are not in this appointment!', ephemeral: true });
        return;
      }
      appointment.participants = appointment.participants.filter(id => id !== userId);
      delete appointment.joinTimes[userId];
      delete appointment.presentUsers[appointment.presentUsers.indexOf(userId)];
      responseMessage = '';
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
        {
          name: 'Time', value: appointment.time.toLocaleString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          }), inline: true
        },
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
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

    // Update the original message
    await interaction.editReply({ embeds: [embed], components: [row] });

    // Send ephemeral response
    if (responseMessage !== '') {
      await interaction.followUp({ content: responseMessage, ephemeral: true });
    }

  } catch (error) {
    console.error('Error handling button click:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ Error processing request!', ephemeral: true }).catch(() => { });
      }
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

// Silly aggressive messages for when appointments are due
const aggressiveMessages = [
  "🔥 **GAME TIME, YOU ABSOLUTE LEGENDS!** 🔥",
  "⚡ **WAKE UP, SLEEPYHEADS! IT'S GAMING O'CLOCK!** ⚡",
  "🚀 **DROP EVERYTHING! YOUR GAME AWAITS!** 🚀",
  "💥 **NO MORE EXCUSES! GET YOUR BUTTS IN GAME!** 💥",
  "🎯 **TIME TO SHOW THE WORLD WHAT YOU'RE MADE OF!** 🎯",
  "⚔️ **BATTLE STATIONS! THE GAME IS CALLING!** ⚔️",
  "🔥 **STOP SCROLLING AND START GAMING!** 🔥",
  "💀 **YOUR TEAMMATES ARE WAITING! DON'T BE THAT PERSON!** 💀",
  "🎮 **GAME ON! LET'S GOOOOO!** 🎮",
  "⚡ **THE MOMENT YOU'VE BEEN WAITING FOR IS HERE!** ⚡"
];

async function showLeaderboard(interaction, appointment) {
  try {
    const guild = await interaction.client.guilds.fetch(appointment.guildId);
    const appointmentTime = new Date(appointment.time);

    // Calculate lateness for each participant
    const latenessData = [];

    for (const userId of appointment.participants) {
      try {
        const member = await guild.members.fetch(userId);
        const username = member.user.username;
        const displayName = nameMapping[username] || username;

        if (appointment.joinTimes[userId]) {
          const joinTime = new Date(appointment.joinTimes[userId]);
          const lateMinutes = Math.max(0, Math.floor((joinTime - appointmentTime) / 60000));

          latenessData.push({
            userId,
            displayName,
            username,
            lateMinutes,
            joinTime
          });
        } else {
          // Never joined
          latenessData.push({
            userId,
            displayName,
            username,
            lateMinutes: Infinity,
            joinTime: null
          });
        }
      } catch (err) {
        console.error(`Error fetching member ${userId}:`, err);
      }
    }

    // Sort by join time to calculate wasted time correctly
    const sortedByJoinTime = latenessData.filter(d => d.joinTime).sort((a, b) => a.joinTime - b.joinTime);

    // Calculate wasted time and waiting time for each person
    let totalWastedMinutes = 0;
    sortedByJoinTime.forEach((person, index) => {
      let wastedByThisPerson = 0;
      let waitingTimeForOthers = 0;

      // For each person who arrived before this person
      for (let i = 0; i < index; i++) {
        const earlierPerson = sortedByJoinTime[i];
        // Calculate how long the earlier person had to wait for this person
        const waitTime = Math.floor((person.joinTime - earlierPerson.joinTime) / 60000);
        wastedByThisPerson += waitTime;
      }

      // Calculate how long this person waited for the last person to join
      if (sortedByJoinTime.length > 0) {
        const lastPerson = sortedByJoinTime[sortedByJoinTime.length - 1];
        // This person waited from their join time until the last person joined
        waitingTimeForOthers = Math.floor((lastPerson.joinTime - person.joinTime) / 60000);
      }

      totalWastedMinutes += wastedByThisPerson;

      // Update user stats
      if (!userStats[person.userId]) {
        userStats[person.userId] = { totalWastedMinutes: 0, incidents: [], weeklyWaste: 0, monthlyWaste: 0 };
      }
      userStats[person.userId].totalWastedMinutes += wastedByThisPerson;
      userStats[person.userId].incidents.push({
        date: new Date().toISOString(),
        wastedMinutes: wastedByThisPerson,
        lateMinutes: person.lateMinutes,
        waitingMinutes: waitingTimeForOthers, // Add waiting time for others
        game: appointment.game
      });
    });

    // Sort by lateness (latest to earliest - most late first)
    latenessData.sort((a, b) => b.lateMinutes - a.lateMinutes);

    // Create leaderboard embed
    const embed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setTitle(`📊 ${appointment.game} - Attendance Report`)
      .setDescription(appointment.cancelled ? '❌ **Appointment Cancelled**' : '✅ **All Present**')
      .setTimestamp();

    let leaderboardText = '';
    latenessData.forEach((data, index) => {
      const position = `${index + 1}.`;
      if (data.lateMinutes === Infinity) {
        leaderboardText += `${position} **${data.displayName}** - ❌ Never showed up\n`;
      } else if (data.lateMinutes === 0) {
        leaderboardText += `${position} **${data.displayName}** - ⏰ On time!\n`;
      } else {
        leaderboardText += `${position} **${data.displayName}** - 🕐 ${data.lateMinutes} min late\n`;
      }
    });

    embed.addFields({ name: '👥 Attendance Ranking', value: leaderboardText || 'No data' });

    if (totalWastedMinutes > 0) {
      embed.addFields({
        name: '⏱️ Total Time Wasted',
        value: `${totalWastedMinutes} minutes of collective waiting time`
      });
    }

    // Save stats
    saveStats(userStats);

    await interaction.editReply({ embeds: [embed], components: [] });

  } catch (error) {
    console.error('Error showing leaderboard:', error);
  }
}

async function generateInsult(absentUsernames) {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'dummy-key') {
    // Fallback insults if no OpenAI key
    const names = absentUsernames.join(', ');
    return `ไอ้ ${names} หายไปไหนมึง? ขี้ขลาดจริงๆ ทำเป็นจะมาเล่น แต่สุดท้ายก็ไม่มาซะที! พวกมึงไม่มีคำว่าความรับผิดชอบหรอกหรือไง? ตอนนัดก็กล้าตอบรับ พอถึงเวลาก็หายไปบ้านมึง! น่าอายจริงๆ! 🤡`;
  }

  try {
    const prompt = `Generate a really aggressive and insulting paragraph in Thai (using street language like "ไอ้สัส", "มึง", "กู", "ส้นตีน", "แม่มึง") to shame these people who promised to play games but didn't come: ${absentUsernames.join(', ')}. Make it funny but harsh, questioning their commitment and wasting everyone's time. Keep it around 3-4 sentences.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [{ role: "user", content: prompt }],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error generating insult:', error);
    const names = absentUsernames.join(', ');
    return `ไอ้ ${names} หนีไปไหนวะ? นัดมาแล้วไม่มาเล่น ไอ้พวกไม่รักษาคำพูด! 🤡`;
  }
}

function startAppointmentScheduler() {
  // Check every minute for appointments that are due and shame checks
  cron.schedule('* * * * *', async () => {
    const now = new Date();

    for (const [messageId, appointment] of appointments.entries()) {
      if (appointment.time <= now && !appointment.notified) {
        // Mark as notified
        appointment.notified = true;

        // Check if party is full
        const isFullParty = appointment.participants.length >= appointment.partySize;

        let notification;

        if (isFullParty) {
          // Full party - send aggressive message and tag everyone
          const randomMessage = aggressiveMessages[Math.floor(Math.random() * aggressiveMessages.length)];
          const mentions = appointment.participants.map(id => `<@${id}>`).join(' ');

          notification = `${randomMessage}\n\n${mentions}\n**${appointment.game}** appointment is NOW!\n${divider}`;
        } else {
          // Not full party - show cancellation message
          const sadMessages = [
            "😢 Well, this is awkward... 😢",
            "😔 Looks like some people chickened out... 😔",
            "😭 The party is incomplete... how sad... 😭",
            "😞 Not everyone could make it... what a shame... 😞",
            "😢 Some people had 'better things' to do... 😢",
            "😔 The squad is incomplete... disappointing... 😔",
            "😭 Looks like commitment isn't everyone's strong suit... 😭",
            "😞 The party is short... how unfortunate... 😞",
            "😢 Some people flaked out... typical... 😢",
            "😔 Not a full house... what a letdown... 😔",
            "😔 Lame jobber... 😔"
          ];

          const randomSadMessage = sadMessages[Math.floor(Math.random() * sadMessages.length)];

          // Create cancellation embed
          const embed = new EmbedBuilder()
            .setColor('#808080')
            .setTitle('❌ Appointment Auto-Cancelled')
            .setDescription(`**${appointment.game}** appointment has been automatically cancelled.`)
            .addFields(
              { name: 'Reason', value: 'Party not full' },
              { name: 'Participants', value: `${appointment.participants.length}/${appointment.partySize}` },
              { name: 'Message', value: randomSadMessage }
            )
            .setTimestamp();

          // Update the original appointment message with cancellation
          try {
            const channel = await client.channels.fetch(appointment.channelId);
            if (channel && channel.isTextBased()) {
              try {
                const message = await channel.messages.fetch(messageId);
                await message.edit({ content: null, embeds: [embed], components: [] });
                console.log(`❌ Updated appointment message to show cancellation for ${appointment.game}`);
              } catch (fetchError) {
                // If can't fetch/edit original message, send new one
                await channel.send({ embeds: [embed] });
                console.log(`❌ Sent cancellation message for ${appointment.game} (original message not found)`);
              }
            }
          } catch (error) {
            console.error('Error updating appointment message:', error);
          }

          // Mark as cancelled and save wasted time stats
          appointment.cancelled = true;
          await saveWastedTimeForCancelledAppointment(appointment);
          appointments.delete(messageId);
          continue; // Skip to next appointment
        }

        // Send new message for full party notification (don't replace original)
        try {
          const channel = await client.channels.fetch(appointment.channelId);
          if (channel && channel.isTextBased()) {
            await channel.send(notification);
            console.log(`🎮 Sent appointment notification for ${appointment.game}`);
          } else {
            console.error(`❌ Channel ${appointment.channelId} not found or not accessible`);
          }
        } catch (error) {
          console.error('Error sending appointment notification:', error);

          // Check if it's a permission error
          if (error.code === 50001) {
            console.error(`
❌ MISSING PERMISSIONS!
The bot cannot access channel ${appointment.channelId}.

Please check:
1. Bot has "MESSAGE CONTENT INTENT" enabled in Developer Portal
2. Bot has these permissions in the channel:
   - View Channels
   - Send Messages
   - Embed Links
3. See PERMISSIONS.md for detailed setup guide
            `);
            // Delete the appointment to avoid repeated errors
            appointments.delete(messageId);
            return;
          }

          // Try to send a simple message instead
          try {
            const channel = client.channels.cache.get(appointment.channelId);
            if (channel && channel.isTextBased()) {
              await channel.send(`🎮 **${appointment.game}** appointment is NOW! (${appointment.participants.length}/${appointment.partySize} players)\n{$divider}`);
            }
          } catch (fallbackError) {
            console.error('Fallback notification also failed:', fallbackError);
          }
        }
      }

      // Auto-cancel if no one joined and 30 minutes passed
      const timeSinceAppointment = now - new Date(appointment.time);
      const minutesSince = Math.floor(timeSinceAppointment / 60000);

      if (minutesSince >= 30 && appointment.participants.length === 0) {
        console.log(`❌ Auto-cancelling ${appointment.game} - no one joined after 30 minutes`);

        try {
          const channel = await client.channels.fetch(appointment.channelId);
          if (channel && channel.isTextBased()) {
            const embed = new EmbedBuilder()
              .setColor('#808080')
              .setTitle('❌ Appointment Auto-Cancelled')
              .setDescription(`**${appointment.game}** appointment has been automatically cancelled.`)
              .addFields(
                { name: 'Reason', value: 'No one joined after 30 minutes' },
                { name: 'Participants', value: '0' }
              )
              .setTimestamp();

            try {
              const message = await channel.messages.fetch(messageId);
              await message.edit({ content: null, embeds: [embed], components: [] });
              console.log(`❌ Updated appointment message to show cancellation (no participants)`);
            } catch (fetchError) {
              await channel.send({ embeds: [embed] });
            }
          }
        } catch (error) {
          console.error('Error sending no-participant cancellation:', error);
        }

        await saveWastedTimeForCancelledAppointment(appointment);
        appointments.delete(messageId);
        continue;
      }

      // Check for absent users after 5, 10, and 15 minutes


      // Check at 5, 10, and 15 minutes
      const checkPoints = [
        { minutes: 5, key: '5min' },
        { minutes: 10, key: '10min' },
        { minutes: 15, key: '15min' },
        { minutes: 30, key: '30min' },
        { minutes: 45, key: '45min' },
        { minutes: 60, key: '60min' },
      ];

      for (const checkpoint of checkPoints) {
        if (minutesSince >= checkpoint.minutes && !appointment.shameChecks[checkpoint.key] && !appointment.cancelled) {
          appointment.shameChecks[checkpoint.key] = true;

          try {
            // Get the guild
            const guild = await client.guilds.fetch(appointment.guildId);

            // First, check who's currently in voice and mark them as present
            for (const userId of appointment.participants) {
              try {
                const member = await guild.members.fetch(userId);

                // If user is in voice channel and not already marked as present
                if (member.voice.channel && !appointment.presentUsers.includes(userId)) {
                  appointment.presentUsers.push(userId);
                  appointment.joinTimes[userId] = new Date().toISOString();
                  console.log(`✅ Marked user ${member.user.username} as present at ${appointment.joinTimes[userId]}`);

                  // Check if everyone is present AND party is full
                  if (appointment.presentUsers.length === appointment.participants.length &&
                    appointment.participants.length >= appointment.partySize) {
                    console.log('🎉 All participants are present and party is full! Showing leaderboard...');
                    // Show leaderboard when everyone arrives
                    const channel = await client.channels.fetch(appointment.channelId);
                    if (channel && channel.isTextBased()) {
                      // Create a fake interaction for leaderboard
                      const fakeInteraction = {
                        client,
                        guildId: appointment.guildId,
                        editReply: async (options) => {
                          await channel.send(options);
                        }
                      };
                      await showLeaderboard(fakeInteraction, appointment);
                      appointments.delete(messageId);
                    }
                  }
                }
              } catch (err) {
                console.error(`Error fetching member ${userId}:`, err);
              }
            }

            // Now check for absent users (only those who haven't been marked as present)
            const absentUsers = [];
            const absentUserIds = [];

            for (const userId of appointment.participants) {
              // Skip users who have already been marked as present
              if (appointment.presentUsers.includes(userId)) {
                continue;
              }

              try {
                const member = await guild.members.fetch(userId);

                // Only shame if they're still not in voice
                if (!member.voice.channel) {
                  const username = member.user.username;
                  // Use mapped name if available, otherwise use Discord username
                  const displayName = nameMapping[username] || username;
                  absentUsers.push(displayName);
                  absentUserIds.push(userId);
                }
              } catch (err) {
                console.error(`Error fetching member ${userId}:`, err);
              }
            }

            // If there are absent users, shame them!
            if (absentUsers.length > 0) {
              const insult = await generateInsult(absentUsers);
              const mentions = absentUserIds.map(id => `<@${id}>`).join(' ');

              const shameMessage = `🔔 **${checkpoint.minutes} minutes passed!**\n${mentions}\n${insult}\n${divider}`;

              const channel = await client.channels.fetch(appointment.channelId);
              if (channel && channel.isTextBased()) {
                await channel.send(shameMessage);
                console.log(`😈 Sent shame message at ${checkpoint.minutes} minutes for ${absentUsers.length} absent users`);
              }
            } else {
              console.log(`✅ All remaining users checked at ${checkpoint.minutes} minutes`);
            }
          } catch (error) {
            console.error(`Error checking voice presence at ${checkpoint.minutes} minutes:`, error);
          }
        }
      }
    }
  });

  console.log('⏰ Appointment scheduler started - checking every minute');
}

async function saveWastedTimeForCancelledAppointment(appointment) {
  try {
    // Only track wasted time if party was full (people were actually waiting)
    if (appointment.participants.length < appointment.partySize) {
      console.log(`⏭️ Skipping wasted time tracking - party was not full (${appointment.participants.length}/${appointment.partySize})`);
      return;
    }

    const guild = await client.guilds.fetch(appointment.guildId);
    const appointmentTime = new Date(appointment.time);
    const now = new Date();

    // Calculate wasted time for participants who joined but never showed up in voice
    for (const userId of appointment.participants) {
      if (!appointment.joinTimes[userId]) {
        // This person joined the appointment but never showed up in voice
        try {
          const member = await guild.members.fetch(userId);

          // Calculate how long they wasted: from appointment time to now
          const minutesWasted = Math.floor((now - appointmentTime) / 60000);

          // They wasted time for everyone who DID show up
          const peopleWhoShowedUp = Object.keys(appointment.joinTimes).length;
          const totalWasted = minutesWasted * peopleWhoShowedUp;

          if (totalWasted > 0) {
            if (!userStats[userId]) {
              userStats[userId] = { totalWastedMinutes: 0, incidents: [] };
            }

            userStats[userId].totalWastedMinutes += totalWasted;
            userStats[userId].incidents.push({
              date: new Date().toISOString(),
              wastedMinutes: totalWasted,
              lateMinutes: minutesWasted,
              game: appointment.game
            });

            console.log(`💾 Saved ${totalWasted} min wasted by ${member.user.username} (no-show for ${appointment.game})`);
          }
        } catch (err) {
          console.error(`Error processing no-show for user ${userId}:`, err);
        }
      }
    }

    // Save stats to file
    saveStats(userStats);
  } catch (error) {
    console.error('Error saving wasted time for cancelled appointment:', error);
  }
}

async function handleWasteboardCommand(interaction) {
  try {
    const period = interaction.options.getString('period') || 'all';
    const guild = await interaction.guild.fetch();

    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getFullYear(), now.getMonth(), 1);

    // Calculate stats based on period
    const leaderboard = [];

    for (const [userId, stats] of Object.entries(userStats)) {
      try {
        const member = await guild.members.fetch(userId);
        const username = member.user.username;
        const displayName = nameMapping[username] || username;

        let wastedMinutes = 0;
        let incidents = 0;

        if (period === 'all') {
          wastedMinutes = stats.totalWastedMinutes;
          incidents = stats.incidents.length;
        } else {
          const cutoffDate = period === 'week' ? weekAgo : monthAgo;
          stats.incidents.forEach(incident => {
            const incidentDate = new Date(incident.date);
            if (incidentDate >= cutoffDate) {
              wastedMinutes += incident.wastedMinutes;
              incidents++;
            }
          });
        }

        if (wastedMinutes > 0) {
          leaderboard.push({ displayName, wastedMinutes, incidents });
        }
      } catch (err) {
        console.error(`Error fetching member ${userId}:`, err);
      }
    }

    // Sort by wasted minutes
    leaderboard.sort((a, b) => b.wastedMinutes - a.wastedMinutes);

    const periodName = period === 'all' ? 'All Time' : period === 'week' ? 'This Week' : 'This Month';

    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle(`⏱️ Time Waster Leaderboard - ${periodName}`)
      .setDescription('Congratulations, you wasted so much time, suckers')
      .setTimestamp();

    if (leaderboard.length === 0) {
      embed.addFields({ name: 'No Data', value: 'No time wasted yet! 🎉' });
    } else {
      let leaderboardText = '';
      leaderboard.slice(0, 10).forEach((entry, index) => {
        const medal = index === 0 ? '💩' : index === 1 ? '🤡' : index === 2 ? '🐌' : `${index + 1}.`;
        leaderboardText += `${medal} **${entry.displayName}** - ${entry.wastedMinutes} min wasted (${entry.incidents} times)\n`;
      });

      embed.addFields({ name: '🏆 Top Time Wasters', value: leaderboardText });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error in wasteboard command:', error);
    await interaction.editReply({ content: '❌ Error showing leaderboard!' });
  }
}

async function handleWaitboardCommand(interaction) {
  try {
    const period = interaction.options.getString('period') || 'all';

    // Calculate date range based on period
    const now = new Date();
    let startDate;

    switch (period) {
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      default:
        startDate = new Date(0); // All time
    }

    // Calculate waiting time for each user
    const waitingStats = {};

    for (const [userId, stats] of Object.entries(userStats)) {
      const filteredIncidents = stats.incidents.filter(incident =>
        new Date(incident.date) >= startDate
      );

      if (filteredIncidents.length > 0) {
        // Calculate total waiting time for this user
        // Use the waitingMinutes field that we now store in incidents
        let totalWaitingMinutes = 0;

        for (const incident of filteredIncidents) {
          // Use the waitingMinutes field if it exists, otherwise fall back to lateMinutes
          if (incident.waitingMinutes !== undefined) {
            totalWaitingMinutes += incident.waitingMinutes;
          } else if (incident.lateMinutes !== Infinity) {
            // Fallback for old data: use lateMinutes as waiting time
            totalWaitingMinutes += incident.lateMinutes;
          }
        }

        waitingStats[userId] = {
          ...stats,
          incidents: filteredIncidents,
          totalWaitingMinutes: totalWaitingMinutes,
          totalWastedMinutes: filteredIncidents.reduce((sum, incident) => sum + incident.wastedMinutes, 0)
        };
      }
    }

    // Sort by total waiting time (most patient first)
    const sortedUsers = Object.entries(waitingStats)
      .filter(([, stats]) => stats.totalWaitingMinutes > 0) // Only show users who actually waited
      .sort(([, a], [, b]) => b.totalWaitingMinutes - a.totalWaitingMinutes)
      .slice(0, 10);

    if (sortedUsers.length === 0) {
      await interaction.editReply({
        embeds: [{
          color: 0x4CAF50,
          title: '⏰ Patience Leaderboard',
          description: `No waiting data found for ${period === 'all' ? 'all time' : period}.`,
          fields: [
            {
              name: 'Period',
              value: period === 'all' ? 'All Time' : period.charAt(0).toUpperCase() + period.slice(1),
              inline: true
            }
          ]
        }]
      });
      return;
    }

    // Create leaderboard embed
    const leaderboardText = sortedUsers.map(([userId, stats], index) => {
      const user = client.users.cache.get(userId);
      const displayName = user ? user.displayName : `User ${userId}`;
      const hours = Math.floor(stats.totalWaitingMinutes / 60);
      const minutes = stats.totalWaitingMinutes % 60;
      const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;

      return `${medal} **${displayName}** - ${timeStr} (${stats.incidents.length} incidents)`;
    }).join('\n');

    const totalWaitingTime = sortedUsers.reduce((sum, [, stats]) => sum + stats.totalWaitingMinutes, 0);
    const totalHours = Math.floor(totalWaitingTime / 60);
    const totalMinutes = totalWaitingTime % 60;
    const totalTimeStr = totalHours > 0 ? `${totalHours}h ${totalMinutes}m` : `${totalMinutes}m`;

    await interaction.editReply({
      embeds: [{
        color: 0x4CAF50,
        title: '⏰ Patience Leaderboard',
        description: leaderboardText,
        fields: [
          {
            name: 'Period',
            value: period === 'all' ? 'All Time' : period.charAt(0).toUpperCase() + period.slice(1),
            inline: true
          },
          {
            name: 'Total Waiting Time',
            value: totalTimeStr,
            inline: true
          },
          {
            name: 'Total Incidents',
            value: sortedUsers.reduce((sum, [, stats]) => sum + stats.incidents.length, 0).toString(),
            inline: true
          }
        ],
        footer: {
          text: 'Higher numbers = more time patiently waiting for others'
        }
      }]
    });
  } catch (error) {
    console.error('Error in waitboard command:', error);
    await interaction.editReply({
      content: '❌ Error generating waitboard. Please try again later.'
    });
  }
}

// Console command system for manual message sending
async function setupConsoleCommands() {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('\n🤖 Console Commands Available:');
  console.log('  send <channelId> <message>  - Send message to specific channel');
  console.log('  sendembed <channelId> <title> <description> <color> - Send embed message');
  console.log('  listchannels - List all channels in all guilds');
  console.log('  listguilds - List all guilds the bot is in');
  console.log('  listusers <guildId> - List users in a specific guild');
  console.log('  help - Show this help message');
  console.log('  exit - Exit the bot\n');

  rl.on('line', async (input) => {
    const args = input.trim().split(' ');
    const command = args[0].toLowerCase();

    try {
      switch (command) {
        case 'send':
          if (args.length < 3) {
            console.log('❌ Usage: send <channelId> <message>');
            break;
          }
          const channelId = args[1];
          const message = args.slice(2).join(' ');
          await sendMessageToChannel(channelId, message);
          break;

        case 'sendembed':
          if (args.length < 5) {
            console.log('❌ Usage: sendembed <channelId> <title> <description> <color>');
            console.log('   Colors: red, green, blue, yellow, purple, orange, pink, gray');
            break;
          }
          const embedChannelId = args[1];
          const title = args[2];
          const description = args[3];
          const color = args[4].toLowerCase();
          await sendEmbedToChannel(embedChannelId, title, description, color);
          break;

        case 'listchannels':
          await listAllChannels();
          break;

        case 'listguilds':
          await listAllGuilds();
          break;

        case 'listusers':
          if (args.length < 2) {
            console.log('❌ Usage: listusers <guildId>');
            break;
          }
          const guildId = args[1];
          await listGuildUsers(guildId);
          break;

        case 'help':
          console.log('\n🤖 Console Commands:');
          console.log('  send <channelId> <message>  - Send message to specific channel');
          console.log('  sendembed <channelId> <title> <description> <color> - Send embed message');
          console.log('  listchannels - List all channels in all guilds');
          console.log('  listguilds - List all guilds the bot is in');
          console.log('  listusers <guildId> - List users in a specific guild');
          console.log('  help - Show this help message');
          console.log('  exit - Exit the bot\n');
          break;

        case 'exit':
          console.log('👋 Shutting down bot...');
          process.exit(0);
          break;

        default:
          console.log('❌ Unknown command. Type "help" for available commands.');
      }
    } catch (error) {
      console.error('❌ Error executing command:', error.message);
    }
  });
}

async function sendMessageToChannel(channelId, message) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.log('❌ Channel not found!');
      return;
    }
    if (!channel.isTextBased()) {
      console.log('❌ Channel is not a text channel!');
      return;
    }

    await channel.send(message);
    console.log(`✅ Message sent to #${channel.name} in ${channel.guild.name}`);
  } catch (error) {
    console.error('❌ Error sending message:', error.message);
  }
}

async function sendEmbedToChannel(channelId, title, description, color) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.log('❌ Channel not found!');
      return;
    }
    if (!channel.isTextBased()) {
      console.log('❌ Channel is not a text channel!');
      return;
    }

    const colorMap = {
      red: '#FF0000',
      green: '#00FF00',
      blue: '#0000FF',
      yellow: '#FFFF00',
      purple: '#800080',
      orange: '#FFA500',
      pink: '#FFC0CB',
      gray: '#808080'
    };

    const embedColor = colorMap[color] || '#5865F2';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(embedColor)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    console.log(`✅ Embed sent to #${channel.name} in ${channel.guild.name}`);
  } catch (error) {
    console.error('❌ Error sending embed:', error.message);
  }
}

async function listAllChannels() {
  try {
    console.log('\n📋 All Channels:');
    for (const [guildId, guild] of client.guilds.cache) {
      console.log(`\n🏰 ${guild.name} (${guildId})`);
      for (const [channelId, channel] of guild.channels.cache) {
        if (channel.isTextBased()) {
          console.log(`  📝 #${channel.name} (${channelId})`);
        }
      }
    }
    console.log('');
  } catch (error) {
    console.error('❌ Error listing channels:', error.message);
  }
}

async function listAllGuilds() {
  try {
    console.log('\n🏰 All Guilds:');
    for (const [guildId, guild] of client.guilds.cache) {
      console.log(`  ${guild.name} (${guildId}) - ${guild.memberCount} members`);
    }
    console.log('');
  } catch (error) {
    console.error('❌ Error listing guilds:', error.message);
  }
}

async function listGuildUsers(guildId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      console.log('❌ Guild not found!');
      return;
    }

    console.log(`\n👥 Users in ${guild.name}:`);

    // Fetch all members (this might take a moment for large servers)
    const members = await guild.members.fetch();

    members.forEach(member => {
      const status = member.presence?.status || 'offline';
      const statusEmoji = {
        online: '🟢',
        idle: '🟡',
        dnd: '🔴',
        offline: '⚫'
      }[status] || '⚫';

      console.log(`  ${statusEmoji} ${member.user.username} (${member.user.id}) - ${member.user.tag}`);
    });

    console.log(`\nTotal: ${members.size} members\n`);
  } catch (error) {
    console.error('❌ Error listing guild users:', error.message);
  }
}

client.login(process.env.DISCORD_TOKEN);