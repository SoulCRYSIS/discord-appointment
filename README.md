# Discord Appointment Bot

A simple Discord bot for creating game appointments with join/leave functionality.

## Setup

1. Create a Discord application at https://discord.com/developers/applications
2. Create a bot and copy the token
3. Copy the application ID
4. Create a `.env` file with:
   ```
   DISCORD_TOKEN=your_bot_token
   CLIENT_ID=your_application_id
   ```
5. Install dependencies: `npm install`
6. Deploy commands: `npm run deploy`
7. Start the bot: `npm start`

## Usage

- `/appointment game:Valorant party_size:5 time:14:30` - Create appointment for 2:30 PM
- `/appointment game:Minecraft party_size:10 time:"in 30 minutes"` - Create appointment in 30 minutes
- Click Join/Leave buttons to participate

## Features

- Create game appointments with custom time
- Join/leave functionality with participant tracking
- Real-time participant list updates
- Simple, reliable implementation
