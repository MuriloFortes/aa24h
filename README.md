# SGA Assistência - Plataforma de Reboque Inteligente

Plataforma de atendimento emergencial de reboque operada por Agentes de IA.

## Arquitetura

```
┌─────────────────────────────────────────────────┐
│                 Canais de Entrada                │
│  WhatsApp (Evolution API)  │  Web Chat (React)   │
└────────────────┬────────────────────┬────────────┘
                 │                    │
        ┌────────▼────────────────────▼────────┐
        │          Express + Socket.IO          │
        │            API Gateway                │
        └────────┬───────────┬─────────────────┘
                 │           │
    ┌────────────▼──┐  ┌─────▼──────────┐
    │    Agente     │  │     Agente     │
    │  Atendente    │  │   Acionador    │
    │  (LLM/NLU)   │  │  (Dispatcher)  │
    └───────┬───────┘  └───────┬────────┘
            │                  │
    ┌───────▼──────────────────▼────────┐
    │         Proto-Analista            │
    │  (Validação SLA + Pagamentos)     │
    └───────────────┬───────────────────┘
                    │
    ┌───────────────▼───────────────────┐
    │   PostgreSQL + PostGIS │ Redis    │
    └───────────────────────────────────┘
```

## Stack

- **Backend**: Node.js + Express + Socket.IO
- **IA**: OpenAI GPT-4o-mini (function calling)
- **WhatsApp**: Evolution API
- **Banco**: SQLite (dev) / PostgreSQL + PostGIS (prod)
- **Frontend**: React + Vite + Tailwind + Leaflet
- **Containers**: Docker Compose

## Quick Start

```bash
cd auto-attendance
npm install

# Configurar variáveis
cp .env.example .env
# Editar .env com suas chaves

# Subir serviços (PostgreSQL, Redis, Evolution API)
docker compose up -d postgres redis evolution-api

# Rodar servidor
npm run dev
```

Web Client:
```bash
cd web-client
npm install
npm run dev
# Acesse http://localhost:3004
```

## Docker (tudo junto)

```bash
docker compose up -d
# App: http://localhost:3003
# Evolution API: http://localhost:8080
```

## API Endpoints

### Atendimentos
- `POST /api/attendance/start` - Iniciar atendimento
- `GET /api/attendance` - Listar atendimentos
- `POST /api/attendance/:id/update` - Atualizar
- `GET /api/tickets/active` - Tickets ativos

### Chat Web
- `POST /api/chat/web` - Enviar mensagem ao agente via web

### WhatsApp
- `GET /api/whatsapp/status` - Status da conexão
- `POST /api/whatsapp/connect` - Conectar
- `POST /api/whatsapp/webhook` - Webhook Evolution API
- `POST /api/whatsapp/send` - Enviar mensagem

### Prestadores
- `GET /api/providers` - Listar
- `POST /api/providers` - Criar
- `GET /api/providers/nearby?lat=X&lng=Y` - Busca geoespacial

### Serviços e Negociações
- `GET /api/services` - Listar serviços
- `GET /api/negotiations` - Listar negociações

### Pagamentos
- `POST /api/payments` - Criar pagamento (PIX)
- `POST /api/payments/:id/confirm` - Confirmar
- `POST /api/payments/:id/send-link` - Enviar link ao cliente

### Analista (SLA)
- `POST /api/analyst/validate-dispatch` - Validar despacho
- `POST /api/analyst/rate` - Avaliar prestador
- `GET /api/analyst/sla-config` - Configuração SLA

### Notificações
- `POST /api/notifications/provider-enroute` - Prestador a caminho
- `POST /api/notifications/provider-arrived` - Prestador chegou
- `POST /api/notifications/service-completed` - Serviço concluído

### Utilitários
- `GET /api/eta?origin_lat=X&origin_lng=X&dest_lat=X&dest_lng=X` - Calcular ETA
- `GET /api/statistics` - Dashboard stats
- `GET /api/audit-logs` - Logs de auditoria

## Fluxo de Atendimento

1. Cliente envia mensagem (WhatsApp ou Web)
2. **Agente Atendente** (LLM) conduz triagem e coleta dados
3. Ticket criado automaticamente após confirmação
4. **Agente Acionador** busca prestadores próximos (PostGIS)
5. Leilão reverso: contata prestadores, negocia valor
6. **Analista** valida SLA, rating, preço
7. Pagamento PIX gerado e enviado ao cliente
8. Prestador confirmado com rota e ETA
9. Notificações em tempo real até conclusão
