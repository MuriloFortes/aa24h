# Deploy no Ubuntu 24.04 — Reboque Já!

Sobe com Docker: app, Postgres/PostGIS, Redis e Evolution API (WhatsApp).
O app ainda grava o atendimento em SQLite (`/app/data/attendance.db`).
Postgres fica para a Evolution e para o schema já preparado.

Postgres e Redis não publicam porta no host. Só o app (`3003`) e o Manager do WhatsApp (`8080`).

## 1. Ferramentas no servidor

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Saia da sessão SSH e entre de novo (o grupo `docker` só vale na sessão nova).

```bash
docker version
docker compose version
```

Firewall: SSH, painel e Manager. Não abra 5432 nem 6379.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 3003/tcp
sudo ufw allow 8080/tcp
sudo ufw --force enable
sudo ufw status
```

## 2. Código

```bash
sudo mkdir -p /opt/reboque
sudo chown "$USER":"$USER" /opt/reboque
git clone https://github.com/MuriloFortes/aa24h.git /opt/reboque
cd /opt/reboque
cp .env.example .env
chmod +x database/init-evolution-db.sh
```

## 3. O que preencher no `.env`

Edite com `nano .env`. Senha do Postgres: só letras e números (ela entra na URL da Evolution).

| Variável | O que colocar |
|---|---|
| `ADMIN_USER` | usuário do painel. Padrão `admin` |
| `ADMIN_PASSWORD` | senha forte do painel |
| `ADMIN_SESSION_SECRET` | `openssl rand -hex 32` |
| `PG_PASSWORD` | senha do Postgres, sem símbolos |
| `EVOLUTION_API_KEY` | `openssl rand -hex 32` |
| `EVOLUTION_SERVER_URL` | `http://SEU_IP_PUBLICO:8080` |
| `WHATSAPP_INSTANCE` | `sga-instance` |
| `ATTENDANCE_FLOW` | `brief` |
| `OPENAI_API_KEY` | chave real da OpenAI, se quiser respostas do modelo |
| `VEHICLE_LOOKUP_DISABLED` | `true` (consulta de placa fica desligada) |

Não copie o `.env` do Mac sem revisar. No servidor, `PG_HOST`, `REDIS_HOST` e `EVOLUTION_API_URL` do arquivo são ignorados: o Compose aponta para os containers.

O webhook do WhatsApp é fixo dentro da rede Docker (`http://app:3003/api/whatsapp/webhook`). Não precisa de domínio para o bot responder.

## 4. Subir

```bash
cd /opt/reboque
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:3003/api/health
```

Health esperado: `"ok": true` e `"sqlite":{"ok":true}`.

- Chat do cliente: `http://SEU_IP:3003`
- Painel: botão **Painel Admin** (usuário e senha do `.env`)
- QR do WhatsApp: `http://SEU_IP:8080` (a API key é a `EVOLUTION_API_KEY`)

Crie a instância `sga-instance` no Manager e leia o QR com o celular. O nome tem de ser o mesmo de `WHATSAPP_INSTANCE`.

## 5. HTTPS (quando tiver domínio)

Aponte o DNS `A` de `reboque.seudominio.com` para o IP do servidor. No `.env`:

```bash
APP_DOMAIN=reboque.seudominio.com
ACME_EMAIL=voce@seudominio.com
```

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
docker compose --profile https up -d
```

O site passa a responder em `https://reboque.seudominio.com`. A porta 3003 continua válida pelo IP.

## Volumes

| Volume | Uso |
|---|---|
| `appdata` | SQLite do atendimento |
| `app_audio` | áudios |
| `pgdata` | PostgreSQL |
| `evolution_instances` | sessão do WhatsApp |

## Atualizar depois de um git pull

```bash
cd /opt/reboque
git pull
docker compose up -d --build
```

## Logs e rollback

```bash
docker compose logs -f app
docker compose logs -f evolution-api
docker compose down
```

`docker compose down` não apaga dados. `docker compose down -v` apaga volumes (banco, SQLite e sessão do WhatsApp).
