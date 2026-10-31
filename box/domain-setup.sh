#!/bin/bash
# Serves the dashboard on a custom name to tailnet devices only. Run on the box with sudo.
# Usage: sudo DOMAIN=dashboard.example.com bash domain-setup.sh
# Needs a Cloudflare API token with Zone > DNS > Edit on that one zone.
set -euo pipefail
domain=${DOMAIN:?set DOMAIN to the dashboard name}
ip=$(tailscale ip -4)
caddy_url='https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/cloudflare'

apt-get install -y -qq dnsmasq curl >/dev/null

# Only tailnet devices are sent here, by Tailscale split DNS. It answers for this one name.
cat >/etc/dnsmasq.d/yantra-domain.conf <<CFG
no-resolv
no-hosts
bind-dynamic
listen-address=$ip
address=/$domain/$ip
CFG

curl -fsSL -o /usr/local/bin/caddy.new "$caddy_url"
chmod 755 /usr/local/bin/caddy.new
/usr/local/bin/caddy.new list-modules | grep -q '^dns.providers.cloudflare$'
mv /usr/local/bin/caddy.new /usr/local/bin/caddy

id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy

if [ ! -s /etc/caddy/cloudflare.env ]; then
    read -rsp 'Cloudflare API token: ' token; echo
    (umask 077; printf 'CF_API_TOKEN=%s\n' "$token" >/etc/caddy/cloudflare.env)
    unset token
fi
chown caddy:caddy /etc/caddy/cloudflare.env

# header_up replaces X-Forwarded-For: the daemon refuses more than one address (ADR-0017).
# resolvers: the challenge must be checked on public DNS, not through split DNS.
cat >/etc/caddy/Caddyfile <<CFG
{
    auto_https disable_redirects
}

https://$domain {
    bind $ip
    tls {
        dns cloudflare {env.CF_API_TOKEN}
        resolvers 1.1.1.1
    }
    reverse_proxy $ip:7717 {
        header_up X-Forwarded-For {remote_host}
    }
}
CFG

cat >/etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy for the dashboard's custom name
After=network-online.target tailscaled.service yantrad.service
Wants=network-online.target

[Service]
User=caddy
Environment=HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
EnvironmentFile=/etc/caddy/cloudflare.env
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
# The tailnet address appears after boot, so keep trying until the bind works.
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /etc/systemd/system/dnsmasq.service.d
cat >/etc/systemd/system/dnsmasq.service.d/yantra.conf <<'UNIT'
[Unit]
After=tailscaled.service

[Service]
Restart=always
RestartSec=5
UNIT

/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile --envfile /etc/caddy/cloudflare.env >/dev/null
systemctl daemon-reload
systemctl enable -q dnsmasq caddy
systemctl restart dnsmasq caddy
echo "domain-setup: done. Add $ip as a split DNS nameserver for $domain in Tailscale."
