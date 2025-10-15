import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName('chronopact')
    .setDescription('Create a game appointment')
    .addStringOption(option =>
      option.setName('game')
        .setDescription('The game to play')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('party_size')
        .setDescription('Maximum party size')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50)
    )
    .addStringOption(option =>
      option.setName('time')
        .setDescription('Time: HH:MM, "in X minutes", or "in X seconds"')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('wasteboard')
    .setDescription('Show time-wasting leaderboard')
    .addStringOption(option =>
      option.setName('period')
        .setDescription('Time period')
        .setRequired(false)
        .addChoices(
          { name: 'All Time', value: 'all' },
          { name: 'This Month', value: 'month' },
          { name: 'This Week', value: 'week' }
        )
    )
    .toJSON()
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

try {
  console.log('🚀 Deploying commands...');
  
  const data = await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
  
  console.log(`✅ Successfully deployed ${data.length} commands!`);
} catch (error) {
  console.error('❌ Error deploying commands:', error);
}