#!/bin/bash
# Setup Nginx reverse proxy for lions-roar-news.com
set -e

echo "=== Installing Nginx ==="
apt install -y nginx

echo "=== Configuring Nginx ==="
cat > /etc/nginx/sites-available/iran-war-news << 'NGEOF'
server {
    listen 80;
    server_name lions-roar-news.com www.lions-roar-news.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGEOF

# Enable site
ln -sf /etc/nginx/sites-available/iran-war-news /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test and restart
nginx -t
systemctl restart nginx
systemctl enable nginx

echo ""
echo "========================================="
echo "  DONE! Nginx is proxying port 80 -> 3000"
echo "  Visit: http://lions-roar-news.com"
echo "========================================="
