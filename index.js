import { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import cron from 'node-cron';
import OpenAI from 'openai';

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

const divider = '________________________________________________________';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Simple in-memory storage
const appointments = new Map();

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  
  // Start the appointment reminder scheduler
  startAppointmentScheduler();
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'chronopact') {
        // Defer IMMEDIATELY before calling handler
        await interaction.deferReply().catch(err => {
          console.error('Failed to defer command interaction:', err);
        });
        await handleAppointmentCommand(interaction);
      }
    } else if (interaction.isButton()) {
      // Defer IMMEDIATELY before calling handler
      await interaction.deferUpdate().catch(err => {
        console.error('Failed to defer button interaction:', err);
      });
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
        { name: 'Time', value: appointmentTime.toLocaleString('en-GB', { 
          hour: '2-digit', 
          minute: '2-digit',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        }), inline: true },
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
      shameChecks: { '5min': false, '10min': false, '15min': false },
      presentUsers: [] // Track users who have shown up in voice
    });
    
    console.log(`Stored appointment with message ID: ${message.id}`);
    
  } catch (error) {
    console.error('Error in appointment command:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Error creating appointment!', ephemeral: true });
      } else {
        await interaction.editReply({ content: '❌ Error creating appointment!' });
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
    const isJoining = interaction.customId === 'join';
    
    let responseMessage = '';
    
    if (isJoining) {
      if (appointment.participants.includes(userId)) {
        await interaction.followUp({ content: '⚠️ You already joined!', ephemeral: true });
        return;
      }
      appointment.participants.push(userId);
      responseMessage = '✅ You joined the appointment!';
    } else {
      if (!appointment.participants.includes(userId)) {
        await interaction.followUp({ content: '⚠️ You are not in this appointment!', ephemeral: true });
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
        { name: 'Time', value: appointment.time.toLocaleString('en-GB', { 
          hour: '2-digit', 
          minute: '2-digit',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        }), inline: true },
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
    
    // Update the original message
    await interaction.editReply({ embeds: [embed], components: [row] });
    
    // Send ephemeral response
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

async function generateInsult(absentUsernames, minutesPassed) {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'dummy-key') {
    // Fallback insults if no OpenAI key
    const names = absentUsernames.join(', ');
    return `ไอ้ ${names} หายไปไหนมึง? ขี้ขลาดจริงๆ ทำเป็นจะมาเล่น แต่สุดท้ายก็ไม่มาซะที! พวกมึงไม่มีคำว่าความรับผิดชอบหรอกหรือไง? ตอนนัดก็กล้าตอบรับ พอถึงเวลาก็หายไปบ้านมึง! น่าอายจริงๆ! 🤡`;
  }

  try {
    const prompt = `Generate a really aggressive and insulting paragraph in Thai (using street language like "ไอ้สัส", "มึง", "กู", "ส้นตีน", "แม่มึง") to shame these people who promised to play games but didn't come: ${absentUsernames.join(', ')}. Make it more aggressive when more minutes passed, ranging from 5-60 minutes (${minutesPassed} minutes passed now). Make it funny but harsh, questioning their commitment and wasting everyone's time. Keep it around 3-4 sentences.`;
    
      const completion = await openai.chat.completions.create({
        model: "gpt-5-mini", // Correct OpenAI model name
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
          
          notification = `${randomMessage}\n\n**${appointment.game}** appointment is NOW!\n${mentions}\n\n*${appointment.participants.length}/${appointment.partySize} players ready to dominate!*\n`;
        } else {
          // Not full party - send sad message without tagging
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
          
          notification = `⏰ **${appointment.game}** appointment is NOW!\n*Only ${appointment.participants.length}/${appointment.partySize} players seem to care...*\n${randomSadMessage}\n${divider}`;
        }
        
        // Send the notification to the channel
        try {
          const channel = await client.channels.fetch(appointment.channelId);
          if (channel && channel.isTextBased()) {
            await channel.send(notification);
            console.log(`🎮 Sent appointment notification for ${appointment.game} in channel ${appointment.channelId}`);
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
      
      // Check for absent users after 5, 10, and 15 minutes
      const timeSinceAppointment = now - new Date(appointment.time);
      const minutesSince = Math.floor(timeSinceAppointment / 60000);
      
      // Check at 5, 10, and 15 minutes
      const checkPoints = [
        { minutes: 0, key: '5min' },
        { minutes: 10, key: '10min' },
        { minutes: 15, key: '15min' },
        { minutes: 30, key: '30min' },
        { minutes: 45, key: '45min' },
        { minutes: 60, key: '60min' },
      ];
      
      for (const checkpoint of checkPoints) {
        if (minutesSince >= checkpoint.minutes && !appointment.shameChecks[checkpoint.key]) {
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
                  console.log(`✅ Marked user ${member.user.username} as present`);
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
              const insult = await generateInsult(absentUsers, minutesSince);
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

client.login(process.env.DISCORD_TOKEN);