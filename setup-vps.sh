#!/bin/bash
# Iran War News - VPS Setup Script
# Run as root on Ubuntu 24.04

set -e

echo "=== Updating system ==="
apt update && apt upgrade -y

echo "=== Installing Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git

echo "=== Cloning repository ==="
cd /opt
git clone https://github.com/Sh-dott/iran-war-news.git
cd iran-war-news

echo "=== Installing dependencies ==="
npm install

echo "=== Creating .env ==="
echo "IMPORTANT: Fill in your real credentials below before starting the service!"
cat > .env << 'ENVEOF'
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN_HERE
TELEGRAM_CHANNEL_ID=@iran_war_news_he
MONGODB_URI=YOUR_MONGODB_URI_HERE
ENVEOF

echo "=== Creating systemd service ==="
cat > /etc/systemd/system/iran-war-news.service << 'SVCEOF'
[Unit]
Description=Iran War News Aggregator
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/iran-war-news
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

echo "=== Starting service ==="
systemctl daemon-reload
systemctl enable iran-war-news
systemctl start iran-war-news

echo "=== Setting up auto-update (git pull every hour) ==="
(crontab -l 2>/dev/null; echo "0 * * * * cd /opt/iran-war-news && git pull && npm install --production && systemctl restart iran-war-news") | crontab -

echo "=== Opening port 3000 ==="
ufw allow 22
ufw allow 80
ufw allow 3000
ufw --force enable

echo ""
echo "========================================="
echo "  DONE! Your app is running on port 3000"
echo "  Visit: http://YOUR_SERVER_IP:3000"
echo "========================================="
echo ""
systemctl status iran-war-news --no-pager
