# Puppy Stardew Web Panel

Lightweight web management panel for Puppy Stardew Server.

## Features

- 🔐 JWT authentication with password management
- 📊 Real-time server status dashboard
- 📝 Live log streaming with filters
- 💻 Interactive terminal for SMAPI console
- 👥 Player management
- 💾 Save file management (backup/download)
- ⚙️ Configuration editor (.env)
- 🎮 Mod management
- 🌐 Chinese/English i18n support

## Access

Default URL: `http://localhost:18642`

On first visit, the panel will ask you to create the admin password in the browser.

## Environment Variables

Set in `.env` file or docker-compose:

```bash
# The panel stores its password hash and JWT secret in panel.json on first setup.
# 首次设置后，面板会将密码哈希和 JWT secret 写入 panel.json。
```

## API Endpoints

- `POST /api/auth/login` - Login
- `POST /api/auth/change-password` - Change password
- `GET /api/status` - Server status
- `GET /api/logs` - Get logs
- `GET /api/players` - List players
- `GET /api/saves` - List saves
- `POST /api/saves/backup` - Create backup
- `GET /api/config` - Get config
- `PUT /api/config` - Update config
- `GET /api/mods` - List mods

## WebSocket

- `/ws` - Real-time log streaming

## Security

- Rate limiting on login (5 attempts per 15 minutes)
- JWT token authentication
- Password hashing with bcrypt
- Session timeout after 1 hour idle
