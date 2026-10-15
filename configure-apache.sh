#!/usr/bin/env bash
set -Eeuo pipefail
DOMAIN=${1:-blackgroup.com.br}
PORT=${2:-8088}

if ! command -v apache2ctl >/dev/null || ! command -v a2enmod >/dev/null; then
  echo "Apache não encontrado. Este instalador espera o Apache com certificado HTTPS existente." >&2; exit 1
fi
if ! systemctl is-active --quiet apache2; then echo "O serviço Apache precisa estar ativo." >&2; exit 1; fi

a2enmod proxy proxy_http >/dev/null
python3 - "$DOMAIN" "$PORT" <<'PY'
import glob, pathlib, re, sys

domain, port = sys.argv[1:]
marker = "# BEGIN telegram-tec-bot callback"
end_marker = "# END telegram-tec-bot callback"
block = f"""{marker}
    ProxyPreserveHost On
    ProxyPass        /tec-login http://127.0.0.1:{port}/tec-login
    ProxyPassReverse /tec-login http://127.0.0.1:{port}/tec-login
    {end_marker}"""
files = glob.glob('/etc/apache2/sites-enabled/*')
for filename in files:
    path = pathlib.Path(filename)
    try: text = path.read_text()
    except (OSError, UnicodeError): continue
    matches = list(re.finditer(r'<VirtualHost\b[^>]*>(.*?)</VirtualHost>', text, re.I | re.S))
    replacements = []
    for match in matches:
        body = match.group(1)
        if not re.search(r'<VirtualHost\b[^>]*:\s*443\s*>', match.group(0), re.I): continue
        names = re.findall(r'^\s*Server(?:Name|Alias)\s+(.+?)\s*$', body, re.I | re.M)
        hosts = {host.lower().rstrip('.') for line in names for host in line.split() if not host.startswith('#')}
        if domain.lower() not in hosts: continue
        cleaned = re.sub(r'\s*' + re.escape(marker) + r'.*?' + re.escape(end_marker) + r'\s*', '\n', body, flags=re.S)
        # Replace legacy /tec-login proxy rules too (the old login used a browser/VNC route).
        cleaned = re.sub(r'^\s*ProxyPass(?:Reverse)?\s+/tec-login(?:/\S*)?\s+\S+[^\n]*\n?', '', cleaned, flags=re.I | re.M)
        new_body = cleaned.rstrip() + '\n    ' + block.replace('\n', '\n    ') + '\n'
        replacements.append((match.start(1), match.end(1), new_body))
    if replacements:
        for start, end, new_body in reversed(replacements): text = text[:start] + new_body + text[end:]
        backup = path.with_name(path.name + '.bak.telegram-tec-bot')
        if not backup.exists(): backup.write_text(path.read_text())
        path.write_text(text)
        print(f'Proxy HTTPS configurado em {path}')
        break
else:
    raise SystemExit(f'Não encontrei VirtualHost HTTPS do Apache com ServerName/ServerAlias {domain}.')
PY

apache2ctl configtest
systemctl reload apache2
